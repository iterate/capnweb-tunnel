import type { RpcTarget } from "capnweb";

export type TunnelFetch = (request: Request) => Response | Promise<Response>;

export interface CapnwebTunnelFetcher extends RpcTarget {
  fetch(request: Request): Response | Promise<Response>;
}

export interface CapnwebTunnelServerApi extends RpcTarget {
  useFetcher(fetcher: CapnwebTunnelFetcher): string | Promise<string>;
}
