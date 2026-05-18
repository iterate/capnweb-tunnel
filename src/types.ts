import type { RpcTarget } from "capnweb";

/** Local fetch implementation the client exposes through the tunnel. */
export type CaptunFetcher = (request: Request) => Response | Promise<Response>;

/** Capability passed from the client to the server after connecting. */
export interface CaptunClientCapability extends RpcTarget {
  /** Handles HTTP requests that the server forwards back to the client. */
  fetch: CaptunFetcher;
}

/** Server RPC API the client calls once the WebSocket session is connected. */
export interface CaptunServerCapability extends RpcTarget {
  /** Registers the client-provided fetcher. */
  useFetcher(fetcher: CaptunClientCapability): void | Promise<void>;
}
