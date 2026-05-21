import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel } from "./index.js";
import {
  captunShardName,
  getTunnelNameFromUrl,
  getTunnelUrl,
  TUNNEL_URL_HEADER,
} from "./routing.js";

type CaptunEnv = Env & {
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
};

/** Set by the top-level Worker on the WebSocket-upgrade request so the DO knows the tunnel. */
const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";

/**
 * A shard Durable Object owns many named tunnels.
 *
 * `SHARD_COUNT=1` keeps every tunnel in one warm object, which gives the
 * lowest connection latency. Raising `SHARD_COUNT` spreads tunnel names over
 * more objects, which adds cold starts when new shards wake up but gives better
 * aggregate throughput for lots of concurrent large responses.
 */
export class CaptunServerShard extends DurableObject<CaptunEnv> {
  private tunnels = new Map<string, ReturnType<typeof acceptCaptunTunnel>["tunnel"]>();

  // The DO's `fetch` only handles the WebSocket upgrade. The upgrade hand-off
  // is special-cased by the Workers runtime around `stub.fetch(...)`: a 101
  // Response with an attached `webSocket` does not survive a DO RPC method
  // return.
  async fetch(request: Request): Promise<Response> {
    const tunnelName = request.headers.get(TUNNEL_NAME_HEADER);
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    const expected = this.env.CAPTUN_SECRET ? `Bearer ${this.env.CAPTUN_SECRET}` : undefined;
    if (expected) {
      const actual = new TextEncoder().encode(request.headers.get("authorization") || "");
      const want = new TextEncoder().encode(expected);
      if (actual.length !== want.length || !timingSafeEqual(actual, want)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
    }

    this.tunnels.get(tunnelName)?.[Symbol.dispose]();
    const { response, tunnel } = acceptCaptunTunnel({
      onDisconnect: () => {
        if (this.tunnels.get(tunnelName) === tunnel) this.tunnels.delete(tunnelName);
      },
    });
    this.tunnels.set(tunnelName, tunnel);
    return response;
  }

  async forward(tunnelName: string, request: Request): Promise<Response> {
    const tunnel = this.tunnels.get(tunnelName);
    if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
    try {
      return await tunnel.fetch(request);
    } catch {
      return new Response("Tunnel fetch failed\n", { status: 502 });
    }
  }
}

export default {
  fetch(request: Request, env: CaptunEnv): Response | Promise<Response> {
    const tunnelName = getTunnelNameFromUrl({
      customHostname: env.CUSTOM_HOSTNAME,
      url: request.url,
    });
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    const url = new URL(request.url);
    const forwardedPath = forwardedRequestPath(url, env.CUSTOM_HOSTNAME);
    url.pathname = forwardedPath;

    const shard = env.CaptunServerShard.getByName(
      captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
    );

    const forwarded = new Request(url, request);

    if (forwardedPath === "/__captun-connect") {
      const headers = new Headers(forwarded.headers);
      headers.set(TUNNEL_NAME_HEADER, tunnelName);
      return shard.fetch(new Request(forwarded, { headers }));
    }

    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname: env.CUSTOM_HOSTNAME,
      tunnelName,
    });
    const headers = new Headers(forwarded.headers);
    headers.set(TUNNEL_URL_HEADER, tunnelUrl);
    return shard.forward(tunnelName, new Request(forwarded, { headers }));
  },
} satisfies ExportedHandler<CaptunEnv>;

function forwardedRequestPath(url: URL, customHostname: string | undefined) {
  if (customHostname) return url.pathname;

  const match = url.pathname.match(/^\/[^/]+(\/.*)?$/);
  return match && match[1] ? match[1] : "/";
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}
