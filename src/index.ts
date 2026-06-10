// oxlint-disable-next-line no-restricted-imports -- this is the only import we do
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

export const HOSTED_CAPTUN_GATEWAY = "https://captun.sh";
export const GATEWAY_CONNECT_QUERY_PARAM = "captun-connect";
export const TUNNEL_NAME_QUERY_PARAM = "captun-name";
/** Legacy Connect Token transport. Tokens ride in `Sec-WebSocket-Protocol` now
 * so they stay out of URL-shaped log fields; the gateway still accepts this
 * query param from old clients. */
export const CONNECT_TOKEN_QUERY_PARAM = "captun-token";
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

export type TunnelReady = {
  url: string;
  token?: string;
};

export interface FetcherStub extends Fetcher, Disposable {
  ready(tunnel: TunnelReady): void | Promise<void>;
}

export interface RemoteFetcherCapability extends FetcherStub {
  onRpcBroken(callback: () => void): void;
}

export function fetcherStubFromRemoteCapability(
  remote: RemoteFetcherCapability,
  options: { onDisconnect?: () => void },
): FetcherStub {
  remote.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request) => remote.fetch(request),
    ready: (tunnel) => remote.ready(tunnel),
    [Symbol.dispose]: () => remote[Symbol.dispose](),
  };
}

export function acceptFetcherCapabilityFromSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
): FetcherStub {
  const remote = newWebSocketRpcSession<FetcherStub>(socket);
  return fetcherStubFromRemoteCapability(remote, options);
}

export function randomConnectToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the Connect Token from wherever the client sent it, in order of
 * preference: the `captun-token.<base64url>` subprotocol (WebSocket connects),
 * the `x-captun-connect-token` header (diagnostic probes, curl), or the legacy
 * `captun-token` query param (old clients).
 */
export function connectTokenFromRequest(request: Request): string | null {
  for (const protocol of offeredSubprotocols(request)) {
    if (protocol.startsWith(CONNECT_TOKEN_PROTOCOL_PREFIX)) {
      const token = base64UrlDecode(protocol.slice(CONNECT_TOKEN_PROTOCOL_PREFIX.length));
      if (token !== null) return token;
    }
  }
  const headerToken = request.headers.get(CONNECT_TOKEN_HEADER);
  if (headerToken) return headerToken;
  return new URL(request.url).searchParams.get(CONNECT_TOKEN_QUERY_PARAM);
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

type TunnelClientCapability = Fetcher & {
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
  private fetcher: Fetcher;
  private onReady: (tunnel: TunnelReady) => void;

  constructor(options: { fetch: Fetcher["fetch"]; ready: (tunnel: TunnelReady) => void }) {
    super();
    this.fetcher = { fetch: options.fetch };
    this.onReady = options.ready;
  }

  fetch(request: Request) {
    return this.fetcher.fetch(request);
  }

  ready(tunnel: TunnelReady) {
    this.onReady(tunnel);
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
