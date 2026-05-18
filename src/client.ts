import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type { CaptunClientCreateTunnelOptions, CaptunClientRemoteFetcher } from "#types";

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
  options: CaptunClientCreateTunnelOptions,
): Promise<Disposable> {
  const socket = createWebSocket(options);
  const session = newWebSocketRpcSession(socket, new LocalFetcher(options));
  await waitUntilOpen(socket);

  return {
    [Symbol.dispose]: () => session[Symbol.dispose](),
  };
}

class LocalFetcher extends RpcTarget implements CaptunClientRemoteFetcher {
  private options: CaptunClientCreateTunnelOptions;

  constructor(options: CaptunClientCreateTunnelOptions) {
    super();
    this.options = options;
  }

  fetch(request: Request) {
    return this.options.fetch(request);
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
      {
        signal: listeners.signal,
      },
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
