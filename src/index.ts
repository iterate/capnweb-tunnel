// oxlint-disable-next-line no-restricted-imports -- this is the only import we do
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

export const HOSTED_CAPTUN_GATEWAY = "https://captun.sh";
export const GATEWAY_CONNECT_QUERY_PARAM = "captun-connect";
export const TUNNEL_NAME_QUERY_PARAM = "captun-name";
export const CONNECT_TOKEN_QUERY_PARAM = "captun-token";
export const TUNNEL_CONNECT_DIAGNOSTIC_HEADER = "x-captun-connect-diagnostic";

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
  const connectUrl = gatewayConnectRequest(options);
  const ready = Promise.withResolvers<TunnelReady>();
  const socket = createWebSocket(connectUrl);
  const fetcher = new TunnelTargetFetcher({
    fetch: options.fetch,
    ready: (tunnel) => ready.resolve(tunnel),
  });
  const session = newWebSocketRpcSession(socket, fetcher);
  try {
    await waitUntilOpen(socket, connectUrl);
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

function gatewayConnectRequest(options: { gateway?: string | URL; name?: string; token?: string }) {
  const name = options.name || randomTunnelName();
  const url = new URL(options.gateway || HOSTED_CAPTUN_GATEWAY);
  const token = options.token || randomConnectToken();
  url.searchParams.set(GATEWAY_CONNECT_QUERY_PARAM, "1");
  url.searchParams.set(TUNNEL_NAME_QUERY_PARAM, name);
  url.searchParams.set(CONNECT_TOKEN_QUERY_PARAM, token);
  return url.toString();
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

function createWebSocket(url: string | URL) {
  const connectUrl = new URL(url);
  connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(connectUrl.href);
}

async function waitUntilOpen(socket: WebSocket, connectUrl: string) {
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
          void webSocketConnectionFailedError(connectUrl).then(reject);
        }),
      { signal: listeners.signal },
    );
    socket.addEventListener(
      "close",
      (event) => {
        listeners.abort();
        void webSocketConnectionFailedError(connectUrl).then((error) => {
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

async function webSocketConnectionFailedError(connectUrl: string) {
  const response = await readWebSocketRejection(connectUrl);
  if (!response) return new CaptunTunnelConnectError("WebSocket connection failed", undefined);
  return new CaptunTunnelConnectError(
    `WebSocket connection failed: ${response.status} ${response.statusText}: ${response.body}`.trim(),
    response,
  );
}

async function readWebSocketRejection(connectUrl: string) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), WEBSOCKET_REJECTION_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(connectUrl, {
      headers: { [TUNNEL_CONNECT_DIAGNOSTIC_HEADER]: "1" },
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

/** Creates a Worker WebSocket upgrade response and matching fetcher stub. */
export function acceptFetcherCapability(options: { onDisconnect?: () => void } = {}) {
  const WorkerWebSocketPair = (
    globalThis as typeof globalThis & { WebSocketPair: WorkerWebSocketPairConstructor }
  ).WebSocketPair;
  const pair = new WorkerWebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];
  const responseInit: WebSocketResponseInit = { status: 101, webSocket: clientSocket };

  serverSocket.accept();
  const fetcher = acceptFetcherCapabilityFromSocket(serverSocket, options);

  return {
    fetcher,
    response: new Response(null, responseInit),
  };
}
