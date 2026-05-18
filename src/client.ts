import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { CapnwebTunnelFetcher, CapnwebTunnelServerApi, TunnelFetch } from "./types";

export interface CapnwebTunnelClientOptions {
  fetch: TunnelFetch;
}

/** Connects a public Worker URL to a local fetch implementation.
 *
 * Capnweb gives us one WebSocket RPC session. The client immediately calls
 * `useFetcher(fetcher)`, passing an RPC target the Worker can call later.
 *
 * https://github.com/cloudflare/capnweb
 */
export class CapnwebTunnelClient {
  #url: URL;
  #server?: RpcStub<CapnwebTunnelServerApi>;
  #fetch: TunnelFetch;

  constructor(serverUrl: string | URL, options: CapnwebTunnelClientOptions) {
    this.#url = new URL(serverUrl);
    this.#fetch = options.fetch;
  }

  async connect(): Promise<string> {
    this.#server = newWebSocketRpcSession<CapnwebTunnelServerApi>(this.#connectUrl());
    return this.#server.useFetcher(new LocalFetcher(this.#fetch));
  }

  close(): void {
    this.#server?.[Symbol.dispose]();
  }

  #connectUrl(): string {
    const url = new URL(this.#url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (!url.pathname.endsWith("/__connect")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/__connect`;
    }
    return url.toString();
  }
}

class LocalFetcher extends RpcTarget implements CapnwebTunnelFetcher {
  #fetch: TunnelFetch;

  constructor(fetch: TunnelFetch) {
    super();
    this.#fetch = fetch;
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.#fetch(request);
  }
}
