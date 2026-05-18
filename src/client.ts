import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { CapnwebTunnelClientCapability, CapnwebTunnelServerCapability, Fetcher } from "./types";

/** Connects a public Worker URL to a local fetch implementation.
 *
 * Capnweb gives us one WebSocket RPC session. The client immediately calls
 * `useFetcher(fetcher)`, passing an RPC target the Worker can call later.
 *
 * https://github.com/cloudflare/capnweb
 */
export class CapnwebTunnelClient {
  private constructor() {}

  static async connect(options: { serverUrl: string | URL; fetch: Fetcher; secret?: string }): Promise<Disposable> {
    const connectUrl = new URL(options.serverUrl);
    connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
    if (!connectUrl.pathname.endsWith("/__connect")) {
      connectUrl.pathname = `${connectUrl.pathname.replace(/\/$/, "")}/__connect`;
    }
    if (options.secret) connectUrl.searchParams.set("secret", options.secret);

    const fetcher = new CapnwebTunnelClientImplementation(options.fetch);
    const server = newWebSocketRpcSession<CapnwebTunnelServerCapability>(connectUrl.toString());
    // This is where we pass our local fetch function to the server.
    await server.useFetcher(fetcher);
    return {
      [Symbol.dispose]: () => {
        server[Symbol.dispose]();
      },
    };
  }
}

class CapnwebTunnelClientImplementation extends RpcTarget implements CapnwebTunnelClientCapability {
  private _fetch: Fetcher;

  constructor(fetch: Fetcher) {
    super();
    this._fetch = fetch;
  }

  fetch(request: Request) {
    return this._fetch(request);
  }
}
