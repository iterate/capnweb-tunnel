import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { acceptCaptunTunnelFromSocket } from "./server-core.js";

/** Fetch is all you need!
 *
 * Cap'n Web let us pass this fetcher from the
 * tunnel client to the server via fetch (via websockets)
 * Then the server can just fetch into the client like normal.
 * This is all possible because Cap'n Web can pass Request and Response object
 * across the websocket RPC boundary transparently
 **/
export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}

/** Creates a tunnel from a public Worker URL to a local fetch implementation.
 *
 * Captun gives us one WebSocket RPC session. The client exposes its fetcher as
 * the session's main object, and the server calls that object through a remote
 * stub when forwarding HTTP requests.
 *
 * Cap'n Web WebSocket sessions:
 * https://github.com/cloudflare/capnweb#websocket-client
 */
export async function createCaptunTunnel(
  options: Fetcher & {
    url: string | URL;
    headers?: Record<string, string>;
  },
): Promise<Disposable> {
  const socket = createWebSocket(options);
  const session = newWebSocketRpcSession(socket, new TunnelTargetFetcher({ fetch: options.fetch }));
  await waitUntilOpen(socket);

  return {
    [Symbol.dispose]: () => session[Symbol.dispose](),
  };
}

class TunnelTargetFetcher extends RpcTarget implements Fetcher {
  private fetcher: Fetcher;

  constructor(fetcher: Fetcher) {
    super();
    this.fetcher = fetcher;
  }

  fetch(request: Request) {
    return this.fetcher.fetch(request);
  }
}

function createWebSocket(options: { url: string | URL; headers?: Record<string, string> }) {
  const connectUrl = new URL(options.url);
  connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
  // TypeScript sees the standard DOM/Workers constructor here, where the second
  // argument is only WebSocket protocols. Node's CLI WebSocket runtime also
  // accepts a headers init object, which we need for tunnel auth.
  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    init?: string | string[] | { headers: Record<string, string> },
  ) => WebSocket;
  return new WebSocketWithHeaders(
    connectUrl.href,
    options.headers ? { headers: options.headers } : undefined,
  );
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

/** Creates a Worker WebSocket upgrade response and matching tunnel handle. */
export function acceptCaptunTunnel(options: { onDisconnect?: () => void } = {}) {
  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  serverSocket.accept();
  const tunnel = acceptCaptunTunnelFromSocket(serverSocket, options);

  return {
    tunnel,
    response: new Response(null, { status: 101, webSocket: clientSocket }),
  };
}

export { acceptCaptunTunnelFromSocket } from "./server-core.js";
