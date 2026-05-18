import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import WebSocket from "ws";
import type { CaptunClientCapability, CreateCaptunTunnelOptions } from "./types";

/** Creates a tunnel from a public Worker URL to a local fetch implementation.
 *
 * Captun gives us one WebSocket RPC session. The client exposes a local
 * `CaptunClientCapability` as the session's main object, and the Worker gets a
 * remote stub for that same object when it accepts the WebSocket.
 *
 * Cap'n Web WebSocket sessions:
 * https://github.com/cloudflare/capnweb#websocket-client
 */
export async function createCaptunTunnel(options: CreateCaptunTunnelOptions): Promise<Disposable> {
  const connectUrl = webSocketUrl(options.url);
  const clientMainObject = new LocalCaptunClientMainObject(options.fetch);
  const socket = await connectWebSocket(connectUrl, options.headers);
  // `clientMainObject` is the object the server will receive as its remote
  // main-object stub. The server does not expose its own useful main object, so
  // we keep the returned stub only as the disposable session handle.
  const session = newWebSocketRpcSession(socket, clientMainObject);
  return {
    [Symbol.dispose]: () => {
      session[Symbol.dispose]();
    },
  };
}

function webSocketUrl(serverUrl: string | URL) {
  const connectUrl = new URL(serverUrl);
  connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
  return connectUrl;
}

function connectWebSocket(url: URL, headers: HeadersInit | undefined): Promise<globalThis.WebSocket> {
  // The standard WebSocket constructor cannot send custom request headers.
  // `ws` has the runtime shape Cap'n Web needs, but not the DOM WebSocket type.
  const socket = new WebSocket(url, headers ? { headers: Object.fromEntries(new Headers(headers)) } : undefined);
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(socket as unknown as globalThis.WebSocket));
    socket.once("error", reject);
  });
}

/** Local object that becomes the server's remote main-object stub. */
class LocalCaptunClientMainObject extends RpcTarget implements CaptunClientCapability {
  private _fetch: CaptunClientCapability["fetch"];

  constructor(fetch: CaptunClientCapability["fetch"]) {
    super();
    this._fetch = fetch;
  }

  fetch(request: Request) {
    return this._fetch(request);
  }
}
