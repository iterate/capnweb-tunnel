import { newWorkersRpcResponse, RpcTarget, type RpcStub } from "capnweb";
import type { CapnwebTunnelFetcher } from "./types";

const CONNECT_PATH = "/__connect";

/** Drop into a Durable Object and call `server.fetch(request)`.
 *
 * The client connects to `CONNECT_PATH` and calls `useFetcher(fetcher)`.
 * Every other request is forwarded through that client-provided fetcher.
 *
 * Capnweb: https://github.com/cloudflare/capnweb
 * Worker WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/ */
export class CapnwebTunnelServer {
  #fetcher?: RpcStub<CapnwebTunnelFetcher>;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith(CONNECT_PATH)) {
      return newWorkersRpcResponse(request, new TunnelControl(this));
    }
    if (!this.#fetcher) return new Response("No tunnel client connected\n", { status: 503 });
    return this.#fetcher.fetch(request);
  }

  useFetcher(fetcher: RpcStub<CapnwebTunnelFetcher>): string {
    this.#fetcher?.[Symbol.dispose]();
    this.#fetcher = fetcher.dup();
    this.#fetcher.onRpcBroken(() => {
      this.#fetcher = undefined;
    });
    return new Date().toISOString();
  }
}

class TunnelControl extends RpcTarget {
  #server: CapnwebTunnelServer;

  constructor(server: CapnwebTunnelServer) {
    super();
    this.#server = server;
  }

  useFetcher(fetcher: RpcStub<CapnwebTunnelFetcher>): string {
    return this.#server.useFetcher(fetcher);
  }
}
