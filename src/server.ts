import { newWebSocketRpcSession } from "capnweb";
import type { AcceptCaptunTunnelOptions, CaptunClientCapability, CaptunServerTunnel } from "./types";

/** Creates a Worker WebSocket upgrade response and matching tunnel handle.
 *
 * Routing, auth, and deciding which requests are connect requests are deliberately
 * outside this helper. The Worker owns that policy; this helper only turns an
 * already-authorized WebSocket request into a server-side `CaptunServerTunnel`.
 *
 * Captun: https://github.com/cloudflare/capnweb
 * Worker WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/ */
export function acceptCaptunTunnel(options: AcceptCaptunTunnelOptions = {}): { response: Response; tunnel: CaptunServerTunnel } {
  const pair = new WebSocketPair();
  const clientSocket = pair[0];
  const serverSocket = pair[1];

  serverSocket.accept();
  // This is the other side of `createCaptunTunnel()`: the client passed a
  // `CaptunClientCapability` into `newWebSocketRpcSession()`, and accepting the
  // same WebSocket returns a stub for that remote client object here.
  //
  // The Durable Object keeps that stub and calls `fetch()` on it later for
  // unrelated public HTTP requests.
  //
  // `newWorkersRpcResponse()` also creates a Worker WebSocket upgrade response,
  // but it only returns the response. Here we need both the response and the
  // remote client stub, so we do the Worker WebSocketPair wiring directly.
  //
  // Docs: https://github.com/cloudflare/capnweb#websocket-client
  const clientMainObjectStub = newWebSocketRpcSession<CaptunClientCapability>(serverSocket);
  clientMainObjectStub.onRpcBroken(() => options.onDisconnect?.());

  const tunnel: CaptunServerTunnel = {
    fetch: (request) => clientMainObjectStub.fetch(request),
    [Symbol.dispose]: () => clientMainObjectStub[Symbol.dispose](),
  };

  return {
    tunnel,
    response: new Response(null, { status: 101, webSocket: clientSocket }),
  };
}
