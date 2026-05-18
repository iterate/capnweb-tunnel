import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import type { CaptunClientCapability, CaptunServerCapability, CaptunFetcher } from "./types";

/** Connects a public Worker URL to a local fetch implementation.
 *
 * Captun gives us one WebSocket RPC session. The client immediately calls
 * `useFetcher(fetcher)`, passing an RPC target the Worker can call later.
 *
 * https://github.com/cloudflare/capnweb
 */
export class CaptunClient {
  private constructor() {}

  static async connect(options: { serverUrl: string | URL; fetch: CaptunFetcher; secret?: string }): Promise<Disposable> {
    const connectUrl = new URL(options.serverUrl);
    connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
    if (!connectUrl.pathname.endsWith("/__connect")) {
      connectUrl.pathname = `${connectUrl.pathname.replace(/\/$/, "")}/__connect`;
    }
    if (options.secret) connectUrl.searchParams.set("secret", options.secret);

    const fetcher = new CaptunClientImplementation(options.fetch);
    const server = newWebSocketRpcSession<CaptunServerCapability>(connectUrl.toString());
    // This is where we pass our local fetch function to the server.
    await server.useFetcher(fetcher);
    return {
      [Symbol.dispose]: () => {
        server[Symbol.dispose]();
      },
    };
  }
}

/**
 * This RpcTarget is passed to the tunnel server.
 */
class CaptunClientImplementation extends RpcTarget implements CaptunClientCapability {
  private _fetch: CaptunFetcher;

  constructor(fetch: CaptunFetcher) {
    super();
    this._fetch = fetch;
  }

  fetch(request: Request) {
    return this._fetch(request);
  }
}
