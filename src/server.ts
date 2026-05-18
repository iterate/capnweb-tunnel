import { newWorkersRpcResponse, RpcTarget, type RpcStub } from "capnweb";
import type { CapnwebTunnelClientCapability } from "./types";

/** Drop into a Durable Object and call `server.fetch(request)`.
 *
 * The client connects to `/__connect` and calls `useFetcher(fetcher)`.
 * Every other request is forwarded through that client-provided fetcher.
 *
 * Capnweb: https://github.com/cloudflare/capnweb
 * Worker WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/ */
export class CapnwebTunnelServer {
  #fetcher?: RpcStub<CapnwebTunnelClientCapability>;

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/__connect")) {
      return newWorkersRpcResponse(request, new TunnelControl(this));
    }
    if (!this.#fetcher) return new Response("No tunnel client connected\n", { status: 503 });
    return this.#fetcher.fetch(request);
  }

  useFetcher(fetcher: RpcStub<CapnwebTunnelClientCapability>) {
    this.#fetcher?.[Symbol.dispose]();
    // Keep our own stub alive, and clear it when the RPC connection breaks:
    // https://github.com/cloudflare/capnweb#duplicating-stubs
    // https://github.com/cloudflare/capnweb#listening-for-disconnect
    this.#fetcher = fetcher.dup();
    this.#fetcher.onRpcBroken(() => {
      this.#fetcher = undefined;
    });
  }
}

class TunnelControl extends RpcTarget {
  #server: CapnwebTunnelServer;

  constructor(server: CapnwebTunnelServer) {
    super();
    this.#server = server;
  }

  useFetcher(fetcher: RpcStub<CapnwebTunnelClientCapability>) {
    this.#server.useFetcher(fetcher);
  }
}
