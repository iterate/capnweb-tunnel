import { newWebSocketRpcSession } from "capnweb";
import type {
  CaptunClientRemoteFetcher,
  CaptunServerAcceptTunnelOptions,
  CaptunServerTunnel,
} from "./types.js";

export interface CaptunRemoteClient extends CaptunClientRemoteFetcher, Disposable {
  onRpcBroken(callback: () => void): void;
}

export function captunTunnelFromRemoteClient(
  remoteClient: CaptunRemoteClient,
  options: CaptunServerAcceptTunnelOptions,
): CaptunServerTunnel {
  remoteClient.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request) => remoteClient.fetch(request),
    [Symbol.dispose]: () => remoteClient[Symbol.dispose](),
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
