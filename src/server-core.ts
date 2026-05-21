import { newWebSocketRpcSession } from "capnweb";

type Fetcher = {
  fetch(request: Request): Response | Promise<Response>;
};

export type CaptunRemoteClient = Fetcher &
  Disposable & {
    onRpcBroken(callback: () => void): void;
  };

export function captunTunnelFromRemoteClient(
  remoteClient: CaptunRemoteClient,
  options: { onDisconnect?: () => void },
) {
  remoteClient.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request: Request) => remoteClient.fetch(request),
    [Symbol.dispose]: () => remoteClient[Symbol.dispose](),
  };
}

export function acceptCaptunTunnelFromSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
) {
  const remoteClient = newWebSocketRpcSession<Fetcher>(socket) as CaptunRemoteClient;
  return captunTunnelFromRemoteClient(remoteClient, options);
}
