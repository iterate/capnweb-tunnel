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
