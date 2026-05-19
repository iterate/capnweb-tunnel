import { newWebSocketRpcSession } from "capnweb";
import { captunTunnelFromRemoteClient, type CaptunRemoteClient } from "./server-core.js";
import type {
  CaptunClientRemoteFetcher,
  CaptunServerAcceptTunnelOptions,
  CaptunServerTunnel,
} from "./types.js";
export type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

/** Creates a Worker WebSocket upgrade response and matching tunnel handle. */
export function acceptCaptunTunnel(options: CaptunServerAcceptTunnelOptions = {}) {
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
  options: CaptunServerAcceptTunnelOptions = {},
): CaptunServerTunnel {
  const remoteClient = newWebSocketRpcSession<CaptunClientRemoteFetcher>(
    socket,
  ) as CaptunRemoteClient;
  return captunTunnelFromRemoteClient(remoteClient, options);
}
