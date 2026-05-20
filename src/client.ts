import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type { Fetcher } from "./types.js";

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
  // tunnelTargetFetcher is the "main object" that comes out on the other side in server.ts 
  // as a capnweb rpc stub that the server can just call fetch on
  const tunnelTargetFetcher = new TunnelTargetFetcher({ fetch: options.fetch });
  const session = newWebSocketRpcSession(socket, tunnelTargetFetcher);
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
