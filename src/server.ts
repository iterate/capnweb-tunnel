import { newWebSocketRpcSession } from "capnweb";
import type { Fetcher } from "./types.js";

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

export function acceptCaptunTunnelFromSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
): Fetcher & Disposable {
  // The generic describes the peer's main object; Cap'n Web still returns a
  // stub with lifecycle methods like onRpcBroken() and Symbol.dispose.
  const tunnelTargetFetcher = newWebSocketRpcSession<Fetcher>(socket);
  tunnelTargetFetcher.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request) => tunnelTargetFetcher.fetch(request),
    [Symbol.dispose]: () => tunnelTargetFetcher[Symbol.dispose](),
  };
}
