import type { RpcTarget } from "capnweb";

/** Local fetch implementation the client exposes through the tunnel. */
export type Fetcher = (request: Request) => Response | Promise<Response>;

/** Capability passed from the client to the server after connecting. */
export interface CapnwebTunnelClientCapability extends RpcTarget {
  /** Handles HTTP requests that the server forwards back to the client. */
  fetch: Fetcher;
}

/** Server RPC API the client calls once the WebSocket session is connected. */
export interface CapnwebTunnelServerCapability extends RpcTarget {
  /** Registers the client-provided fetcher. */
  useFetcher(fetcher: CapnwebTunnelClientCapability): void | Promise<void>;
}
