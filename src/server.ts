import { newWorkersRpcResponse, RpcTarget, type RpcStub } from "capnweb";
import type { CaptunClientCapability, CaptunServerCapability } from "./types";

/** Drop into a Durable Object and call `server.fetch(request)`.
 *
 * The client connects to `/__connect` and calls `useFetcher(fetcher)`.
 * Every other request is forwarded through that client-provided fetcher.
 *
 * Captun: https://github.com/cloudflare/capnweb
 * Worker WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/ */
export class CaptunServer {
  #fetcher?: RpcStub<CaptunClientCapability>;
  #secret?: string;
  #onDisconnect?: () => void;

  constructor(options: { secret?: string; onDisconnect?: () => void } = {}) {
    this.#secret = options.secret;
    this.#onDisconnect = options.onDisconnect;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/__connect") {
      if (this.#secret && url.searchParams.get("secret") !== this.#secret) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      // Keep the RPC surface narrow; RpcTarget exposes all prototype methods.
      return newWorkersRpcResponse(request, new CaptunServerImplementation(this));
    }
    if (!this.#fetcher) return new Response("No tunnel client connected\n", { status: 503 });
    return this.#fetcher.fetch(request);
  }

  useFetcher(fetcher: RpcStub<CaptunClientCapability>) {
    this.#fetcher?.[Symbol.dispose]();
    // Keep our own stub alive, and clear it when the RPC connection breaks:
    // https://github.com/cloudflare/capnweb#duplicating-stubs
    // https://github.com/cloudflare/capnweb#listening-for-disconnect
    const activeFetcher = fetcher.dup();
    this.#fetcher = activeFetcher;
    activeFetcher.onRpcBroken(() => {
      if (this.#fetcher === activeFetcher) {
        this.#fetcher = undefined;
        this.#onDisconnect?.();
      }
    });
  }
}

class CaptunServerImplementation extends RpcTarget implements CaptunServerCapability {
  readonly server: CaptunServer;

  constructor(server: CaptunServer) {
    super();
    this.server = server;
  }

  useFetcher(fetcher: RpcStub<CaptunClientCapability>) {
    this.server.useFetcher(fetcher);
  }
}
