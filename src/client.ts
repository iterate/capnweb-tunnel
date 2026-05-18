import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { CapnwebTunnelServerCapability, Fetcher } from "./types";

/** Connects a public Worker URL to a local fetch implementation.
 *
 * Capnweb gives us one WebSocket RPC session. The client immediately calls
 * `useFetcher(fetcher)`, passing an RPC target the Worker can call later.
 *
 * https://github.com/cloudflare/capnweb
 */
export class CapnwebTunnelClient {
  #connectUrl: string;
  #server?: RpcStub<CapnwebTunnelServerCapability>;
  #fetcher: RpcTarget & { fetch: Fetcher };

  constructor(serverUrl: string | URL, options: { fetch: Fetcher }) {
    const connectUrl = new URL(serverUrl);
    connectUrl.protocol = connectUrl.protocol === "https:" ? "wss:" : "ws:";
    if (!connectUrl.pathname.endsWith("/__connect")) {
      connectUrl.pathname = `${connectUrl.pathname.replace(/\/$/, "")}/__connect`;
    }

    this.#connectUrl = connectUrl.toString();
    const localFetch = options.fetch;
    this.#fetcher = new (class extends RpcTarget {
      fetch(request: Request) {
        return localFetch(request);
      }
    })();
  }

  async connect() {
    this.#server = newWebSocketRpcSession<CapnwebTunnelServerCapability>(this.#connectUrl);
    // This is where we pass our local fetch function to the server
    await this.#server.useFetcher(this.#fetcher);
  }

  close() {
    this.#server?.[Symbol.dispose]();
  }
}
