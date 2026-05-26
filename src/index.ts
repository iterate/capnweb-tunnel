import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import {
  CONNECT_TOKEN_QUERY_PARAM,
  GATEWAY_CONNECT_QUERY_PARAM,
  HOSTED_CAPTUN_GATEWAY,
  TUNNEL_NAME_QUERY_PARAM,
} from "./routing.js";
import { acceptFetcherCapabilityFromSocket } from "./server-core.js";
import type { Fetcher, TunnelReady } from "./server-core.js";
export type { Fetcher, FetcherStub } from "./server-core.js";
export { acceptFetcherCapabilityFromSocket } from "./server-core.js";

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

type TunnelClientCapability = Fetcher & {
  ready(tunnel: TunnelReady): void | Promise<void>;
};

const TUNNEL_READY_TIMEOUT_MS = 5_000;

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
  const socket = createWebSocket(connect.url);
  const fetcher = new TunnelTargetFetcher({
    fetch: options.fetch,
    ready: (tunnel) => ready.resolve(tunnel),
  });
  const session = newWebSocketRpcSession(socket, fetcher);
  try {
    await waitUntilOpen(socket);
    const tunnel = await waitUntilReady(ready.promise);
    return {
      url: tunnel.url,
      token: tunnel.token || connect.token,
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
  url.searchParams.set(GATEWAY_CONNECT_QUERY_PARAM, "1");
  url.searchParams.set(TUNNEL_NAME_QUERY_PARAM, name);
  if (options.token) url.searchParams.set(CONNECT_TOKEN_QUERY_PARAM, options.token);
  return { url: url.toString(), name, token: options.token };
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

async function waitUntilOpen(socket: WebSocket) {
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
      () => settle(() => reject(new Error("WebSocket connection failed"))),
      { signal: listeners.signal },
    );
    socket.addEventListener(
      "close",
      (event) => {
        listeners.abort();
        reject(new Error(`WebSocket closed before opening: ${event.code} ${event.reason}`));
      },
      { signal: listeners.signal },
    );
  });
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
  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  serverSocket.accept();
  const fetcher = acceptFetcherCapabilityFromSocket(serverSocket, options);

  return {
    fetcher,
    response: new Response(null, { status: 101, webSocket: clientSocket }),
  };
}
