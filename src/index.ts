// oxlint-disable-next-line no-restricted-imports -- this is the only import we do
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

export const HOSTED_CAPTUN_GATEWAY = "https://captun.sh";
export const GATEWAY_CONNECT_QUERY_PARAM = "captun-connect";
export const TUNNEL_NAME_QUERY_PARAM = "captun-name";
export const TUNNEL_CONNECT_DIAGNOSTIC_HEADER = "x-captun-connect-diagnostic";
/** Connect Token transport for plain HTTP requests (the diagnostic probe, curl). */
export const CONNECT_TOKEN_HEADER = "x-captun-connect-token";
/** Marker subprotocol offered on every connect; the gateway echoes it on the
 * 101 response (browsers and strict clients abort the handshake otherwise). */
export const CONNECT_PROTOCOL = "captun";
/** Connect Token subprotocol: `captun-token.<base64url(token)>`. base64url
 * because RFC 6455 limits subprotocol values to HTTP token characters. */
export const CONNECT_TOKEN_PROTOCOL_PREFIX = "captun-token.";

export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}

export interface WebSocketFetcher {
  connectWebSocket(
    request: Request,
    remote: WebSocketHandle,
  ): WebSocketConnectResult | Promise<WebSocketConnectResult>;
}

export type TunnelReady = {
  url: string;
  token?: string;
};

export interface FetcherStub extends Fetcher, WebSocketFetcher, Disposable {
  ready(tunnel: TunnelReady): void | Promise<void>;
}

export interface RemoteFetcherCapability extends FetcherStub {
  onRpcBroken(callback: () => void): void;
}

export type WebSocketMessage = string | Uint8Array;

/**
 * A tunneled WebSocket as a Cap'n Web capability: each side of a tunneled
 * connection holds a handle to the socket on the other side and forwards
 * messages by calling it. Cap'n Web delivers calls in order, so no extra
 * framing is needed.
 */
export interface WebSocketHandle {
  send(message: WebSocketMessage): unknown;
  close(code?: number, reason?: string): unknown;
}

export type WebSocketConnectResult =
  | { accepted: true; protocol?: string; socket: WebSocketHandle }
  | { accepted: false; response: Response };

export function fetcherStubFromRemoteCapability(
  remote: RemoteFetcherCapability,
  options: { onDisconnect?: () => void },
): FetcherStub {
  remote.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request) => remote.fetch(request),
    connectWebSocket: (request, handle) => remote.connectWebSocket(request, handle),
    ready: (tunnel) => remote.ready(tunnel),
    [Symbol.dispose]: () => remote[Symbol.dispose](),
  };
}

export function acceptFetcherCapabilityFromSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
): FetcherStub {
  const remote = newWebSocketRpcSession<FetcherStub>(socket) as unknown as RemoteFetcherCapability;
  return fetcherStubFromRemoteCapability(remote, options);
}

export function randomConnectToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the Connect Token from where the client sent it: the
 * `captun-token.<base64url>` subprotocol (WebSocket connects) or the
 * `x-captun-connect-token` header (diagnostic probes, curl). Never the URL —
 * URLs are logged by default.
 */
export function connectTokenFromRequest(request: Request): string | null {
  for (const protocol of offeredSubprotocols(request)) {
    if (protocol.startsWith(CONNECT_TOKEN_PROTOCOL_PREFIX)) {
      const token = base64UrlDecode(protocol.slice(CONNECT_TOKEN_PROTOCOL_PREFIX.length));
      if (token !== null) return token;
    }
  }
  return request.headers.get(CONNECT_TOKEN_HEADER);
}

/**
 * The subprotocol a server should select (and echo on the 101 response) for a
 * captun connect request, or undefined when the client offered none. For
 * runtimes that negotiate the subprotocol themselves, e.g.
 * `Deno.upgradeWebSocket(request, { protocol: connectProtocolFromRequest(request) })`.
 * `acceptFetcherCapability` does this automatically when given the request.
 */
export function connectProtocolFromRequest(request: Request): string | undefined {
  return offeredSubprotocols(request).includes(CONNECT_PROTOCOL) ? CONNECT_PROTOCOL : undefined;
}

function offeredSubprotocols(request: Request) {
  const header = request.headers.get("sec-websocket-protocol");
  if (!header) return [];
  return header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function base64UrlEncode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string) {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Fetch is all you need!
 *
 * Cap'n Web lets us pass this fetcher from the tunnel client to the gateway.
 * The gateway can then call fetch on the client like normal, with Request and
 * Response objects crossing the WebSocket RPC boundary transparently.
 **/
export type CaptunTunnel = Disposable & {
  url: string;
  token?: string;
};

export class CaptunTunnelConnectError extends Error {
  response: { status: number; statusText: string; body: string } | undefined;

  constructor(
    message: string,
    response: { status: number; statusText: string; body: string } | undefined,
  ) {
    super(message);
    this.name = "CaptunTunnelConnectError";
    this.response = response;
  }
}

type TunnelClientCapability = Fetcher &
  WebSocketFetcher & {
    ready(tunnel: TunnelReady): void | Promise<void>;
  };

type WorkerWebSocket = WebSocket & {
  accept(): void;
};

type WorkerWebSocketPairConstructor = new () => {
  0: WorkerWebSocket;
  1: WorkerWebSocket;
};

type WebSocketResponseInit = ResponseInit & {
  webSocket: WebSocket;
};

const TUNNEL_READY_TIMEOUT_MS = 5_000;
const WEBSOCKET_REJECTION_PROBE_TIMEOUT_MS = 500;

/** Creates a public tunnel by exposing a local fetch implementation to a Tunnel Gateway. */
export async function createCaptunTunnel(
  options: Fetcher & {
    connectWebSocket?: WebSocketFetcher["connectWebSocket"];
    gateway?: string | URL;
    name?: string;
    token?: string;
  },
): Promise<CaptunTunnel> {
  const connect = gatewayConnectRequest(options);
  const ready = Promise.withResolvers<TunnelReady>();
  const socket = createWebSocket(connect.url, connect.protocols);
  const fetcher = new TunnelTargetFetcher({
    fetch: options.fetch,
    connectWebSocket: options.connectWebSocket,
    ready: (tunnel) => ready.resolve(tunnel),
  });
  const session = newWebSocketRpcSession(socket, fetcher);
  try {
    await waitUntilOpen(socket, connect);
    const tunnel = await waitUntilReady(ready.promise);
    return {
      ...tunnel,
      [Symbol.dispose]: () => session[Symbol.dispose](),
    };
  } catch (error) {
    session[Symbol.dispose]();
    throw error;
  }
}

type GatewayConnectRequest = {
  url: string;
  token: string;
  protocols: string[];
};

function gatewayConnectRequest(options: {
  gateway?: string | URL;
  name?: string;
  token?: string;
}): GatewayConnectRequest {
  const name = options.name || randomTunnelName();
  const url = new URL(options.gateway || HOSTED_CAPTUN_GATEWAY);
  const token = options.token || randomConnectToken();
  url.searchParams.set(GATEWAY_CONNECT_QUERY_PARAM, "1");
  url.searchParams.set(TUNNEL_NAME_QUERY_PARAM, name);
  // The token deliberately stays out of the URL — URLs are logged by default
  // (gateway request logs, logpush, exception traces). It rides in the
  // Sec-WebSocket-Protocol header instead.
  return {
    url: url.toString(),
    token,
    protocols: [CONNECT_PROTOCOL, CONNECT_TOKEN_PROTOCOL_PREFIX + base64UrlEncode(token)],
  };
}

function randomTunnelName() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class TunnelTargetFetcher extends RpcTarget implements TunnelClientCapability {
  private fetcher: Fetcher & Partial<WebSocketFetcher>;
  private onReady: (tunnel: TunnelReady) => void;

  constructor(options: {
    fetch: Fetcher["fetch"];
    connectWebSocket?: WebSocketFetcher["connectWebSocket"];
    ready: (tunnel: TunnelReady) => void;
  }) {
    super();
    this.fetcher = { fetch: options.fetch };
    if (options.connectWebSocket) this.fetcher.connectWebSocket = options.connectWebSocket;
    this.onReady = options.ready;
  }

  fetch(request: Request) {
    return this.fetcher.fetch(request);
  }

  ready(tunnel: TunnelReady) {
    this.onReady(tunnel);
  }

  async connectWebSocket(request: Request, remote: WebSocketHandle) {
    if (this.fetcher.connectWebSocket) return this.fetcher.connectWebSocket(request, remote);

    const response = await this.fetcher.fetch(createWebSocketUpgradeRequest(request));
    const socket = responseWebSocket(response);
    if (!socket) return { accepted: false as const, response };

    acceptIfNeeded(socket);
    pipeWebSocketToHandle(socket, remote);
    return {
      accepted: true as const,
      protocol: response.headers.get("sec-websocket-protocol") || undefined,
      socket: webSocketHandleFromSocket(socket),
    };
  }
}

function createWebSocket(url: string | URL, protocols: string[]) {
  const connectUrl = new URL(url);
  connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(connectUrl.href, protocols);
}

async function waitUntilOpen(socket: WebSocket, connect: GatewayConnectRequest) {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw new Error("WebSocket closed before opening");
  }

  const listeners = new AbortController();
  await new Promise<void>((resolve, reject) => {
    const settle = (callback: () => void) => {
      listeners.abort();
      callback();
    };
    socket.addEventListener("open", () => settle(resolve), { signal: listeners.signal });
    socket.addEventListener(
      "error",
      () =>
        settle(() => {
          void webSocketConnectionFailedError(connect).then(reject);
        }),
      { signal: listeners.signal },
    );
    socket.addEventListener(
      "close",
      (event) => {
        listeners.abort();
        void webSocketConnectionFailedError(connect).then((error) => {
          reject(
            error.response
              ? error
              : new Error(`WebSocket closed before opening: ${event.code} ${event.reason}`),
          );
        });
      },
      { signal: listeners.signal },
    );
  });
}

async function webSocketConnectionFailedError(connect: GatewayConnectRequest) {
  const response = await readWebSocketRejection(connect);
  if (!response) return new CaptunTunnelConnectError("WebSocket connection failed", undefined);
  return new CaptunTunnelConnectError(
    `WebSocket connection failed: ${response.status} ${response.statusText}: ${response.body}`.trim(),
    response,
  );
}

async function readWebSocketRejection(connect: GatewayConnectRequest) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), WEBSOCKET_REJECTION_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(connect.url, {
      headers: {
        [TUNNEL_CONNECT_DIAGNOSTIC_HEADER]: "1",
        [CONNECT_TOKEN_HEADER]: connect.token,
      },
      signal: abort.signal,
    });
    if (response.ok) return undefined;
    return {
      status: response.status,
      statusText: response.statusText || "Rejected",
      body: (await response.text()).trim(),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitUntilReady(promise: Promise<TunnelReady>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for tunnel gateway ready message")),
          TUNNEL_READY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Creates a Worker WebSocket upgrade response and matching fetcher stub.
 *
 * Pass the upgrade `request` so the 101 response echoes the `captun`
 * subprotocol when the client offered one — browsers and strict WebSocket
 * clients abort the handshake if the server doesn't select an offered
 * subprotocol. The token-bearing subprotocol is never echoed.
 */
export function acceptFetcherCapability(
  options: { request?: Request; onDisconnect?: () => void } = {},
) {
  const WorkerWebSocketPair = (
    globalThis as typeof globalThis & { WebSocketPair: WorkerWebSocketPairConstructor }
  ).WebSocketPair;
  const pair = new WorkerWebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];
  const responseInit: WebSocketResponseInit = { status: 101, webSocket: clientSocket };
  if (options.request && offeredSubprotocols(options.request).includes(CONNECT_PROTOCOL)) {
    responseInit.headers = { "sec-websocket-protocol": CONNECT_PROTOCOL };
  }

  serverSocket.accept();
  const fetcher = acceptFetcherCapabilityFromSocket(serverSocket, options);

  return {
    fetcher,
    response: new Response(null, responseInit),
  };
}

export function isWebSocketUpgradeRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Exposes a local WebSocket as a WebSocketHandle the other side of a tunnel can call. */
export function webSocketHandleFromSocket(socket: WebSocket): WebSocketHandle {
  return new SocketHandle(socket);
}

class SocketHandle extends RpcTarget implements WebSocketHandle {
  constructor(private socket: WebSocket) {
    super();
  }

  send(message: WebSocketMessage) {
    this.socket.send(message);
  }

  close(code?: number, reason?: string) {
    closeWebSocket(this.socket, code, reason);
  }
}

/**
 * Forwards every message and the final close from a local WebSocket to the
 * remote side's handle. Conversions are chained so messages arrive in order
 * even when a runtime delivers binary frames as Blobs (async to read).
 */
export function pipeWebSocketToHandle(socket: WebSocket, handle: WebSocketHandle): void {
  // Cap'n Web disposes stubs received as call arguments when the call
  // returns; dup() keeps the capability alive for the socket's lifetime.
  const remote = dupStub(handle);
  const closeFailed = () => closeWebSocket(socket, 1011, "WebSocket tunnel failed");
  let pending = Promise.resolve();
  const enqueue = (action: () => void | Promise<void>) => {
    pending = pending.then(action).catch(closeFailed);
  };
  // A failed forward means the tunnel side is gone; close our side too.
  const forward = (call: unknown) => {
    void Promise.resolve(call).catch(closeFailed);
  };

  let finished = false;
  const finish = (code?: number, reason?: string) => {
    if (finished) return;
    finished = true;
    enqueue(() => {
      try {
        forward(remote.close(code, reason));
      } finally {
        disposeStub(remote);
      }
    });
  };

  socket.addEventListener("message", (event) => {
    if (finished) return;
    enqueue(async () => {
      forward(remote.send(await webSocketMessage(event.data)));
    });
  });
  socket.addEventListener("close", (event) => finish(event.code, event.reason));
  socket.addEventListener("error", () => finish(1011, "WebSocket error"));
}

type StubLike = { dup?(): unknown; [Symbol.dispose]?(): void };

function dupStub(handle: WebSocketHandle): WebSocketHandle {
  const dup = (handle as WebSocketHandle & StubLike).dup;
  return typeof dup === "function" ? (dup.call(handle) as WebSocketHandle) : handle;
}

function disposeStub(handle: WebSocketHandle) {
  (handle as WebSocketHandle & StubLike)[Symbol.dispose]?.();
}

/**
 * Normalizes a message event payload to string | Uint8Array. Checks are
 * realm-safe (no bare instanceof) because tunneled sockets can come from
 * other contexts — e.g. miniflare delivers Blobs from its own realm — and
 * the copy yields a true Uint8Array, which Cap'n Web's serializer requires
 * (a Node Buffer's prototype is not Uint8Array.prototype).
 */
async function webSocketMessage(data: unknown): Promise<WebSocketMessage> {
  if (typeof data === "string") return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    return new Uint8Array(data as ArrayBuffer).slice();
  }
  if (typeof (data as Blob | null)?.arrayBuffer === "function") {
    return new Uint8Array(await (data as Blob).arrayBuffer());
  }
  return String(data);
}

function closeWebSocket(socket: WebSocket, code?: number, reason?: string) {
  // WebSocket.close() only accepts 1000 or 3000-4999; other codes (1001,
  // 1011, ...) are receive-only and must fall back to a bare close.
  try {
    if (code === undefined || code === 1000 || (code >= 3000 && code <= 4999)) {
      socket.close(code, reason);
    } else {
      socket.close();
    }
  } catch {
    // Already closed or closing.
  }
}

function acceptIfNeeded(socket: WebSocket) {
  const maybeWorkerSocket = socket as WebSocket & { accept?: () => void };
  if (typeof maybeWorkerSocket.accept === "function") maybeWorkerSocket.accept();
}

function responseWebSocket(response: Response): WebSocket | undefined {
  return (response as Response & { webSocket?: WebSocket | null }).webSocket || undefined;
}

function createWebSocketUpgradeRequest(request: Request) {
  const headers = new Headers(request.headers);
  headers.set("upgrade", "websocket");
  return new Request(request.url, { headers });
}
