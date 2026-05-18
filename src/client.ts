import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type { CaptunClientCreateTunnelOptions, CaptunClientRemoteFetcher, Fetcher } from "./types";

/** Creates a tunnel from a public Worker URL to a local fetch implementation.
 *
 * Captun gives us one WebSocket RPC session. The client exposes its fetcher as
 * the session's main object, and the server calls that object through a remote
 * stub when forwarding HTTP requests.
 *
 * Cap'n Web WebSocket sessions:
 * https://github.com/cloudflare/capnweb#websocket-client
 */
export async function createCaptunTunnel(options: CaptunClientCreateTunnelOptions): Promise<Disposable> {
  const socket = createWebSocket(options);
  const session = newWebSocketRpcSession(socket, new LocalFetcher(options.fetch));
  await waitUntilOpen(socket);

  return {
    [Symbol.dispose]: () => session[Symbol.dispose](),
  };
}

class LocalFetcher extends RpcTarget implements CaptunClientRemoteFetcher {
  constructor(private readonly fetcher: Fetcher["fetch"]) {
    super();
  }

  fetch(request: Request) {
    return this.fetcher(request);
  }
}

function createWebSocket(options: CaptunClientCreateTunnelOptions) {
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

  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
    socket.onclose = (event: CloseEvent) => {
      reject(new Error(`WebSocket closed before opening: ${event.code} ${event.reason}`));
    };
  }).finally(() => {
    socket.onopen = null;
    socket.onerror = null;
    socket.onclose = null;
  });
}
