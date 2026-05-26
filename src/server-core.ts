import { newWebSocketRpcSession } from "capnweb";

export interface Fetcher {
  fetch(request: Request): Response | Promise<Response>;
}

export type TunnelReady = {
  url: string;
  token?: string;
};

export type FetcherStub = Fetcher &
  Disposable & {
    ready(tunnel: TunnelReady): void | Promise<void>;
  };

type FetcherCapability = Fetcher & {
  ready(tunnel: TunnelReady): void | Promise<void>;
};

export type RemoteFetcherCapability = FetcherCapability &
  Disposable & {
    onRpcBroken(callback: () => void): void;
  };

export function fetcherStubFromRemoteCapability(
  remote: RemoteFetcherCapability,
  options: { onDisconnect?: () => void },
): FetcherStub {
  remote.onRpcBroken(() => options.onDisconnect?.());

  return {
    fetch: (request) => remote.fetch(request),
    ready: (tunnel) => remote.ready(tunnel),
    [Symbol.dispose]: () => remote[Symbol.dispose](),
  };
}

export function acceptFetcherCapabilityFromSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
): FetcherStub {
  const remote = newWebSocketRpcSession<FetcherCapability>(socket) as RemoteFetcherCapability;
  return fetcherStubFromRemoteCapability(remote, options);
}
