import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type { CaptunClientCreateTunnelOptions, CaptunClientRemoteFetcher } from "./types";

/** Creates a tunnel from a public Worker URL to a local fetch implementation.
 *
 * Captun gives us one WebSocket RPC session. The client exposes its fetcher as
 * the session's main object, and the server calls that object through a remote
 * stub when forwarding HTTP requests.
 *
 * Cap'n Web WebSocket sessions:
 * https://github.com/cloudflare/capnweb#websocket-client
 */
export function createCaptunTunnel(options: CaptunClientCreateTunnelOptions): Promise<Disposable> {
  const connectUrl = new URL(options.url);
  connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
  // The unified tsconfig sees the DOM/Workers WebSocket constructor, which only
  // types the second argument as protocols. The CLI runtime accepts a headers
  // init object, and we use that for tunnel auth.
  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    init?: string | string[] | { headers: Record<string, string> },
  ) => WebSocket;
  const socket = new WebSocketWithHeaders(
    connectUrl.href,
    options.headers ? { headers: options.headers } : undefined,
  );
  const session = newWebSocketRpcSession(
    socket,
    new (class extends RpcTarget implements CaptunClientRemoteFetcher {
      fetch(request: Request) {
        return options.fetch(request);
      }
    })(),
  );

  return Promise.resolve({
    [Symbol.dispose]: () => session[Symbol.dispose](),
  });
}
