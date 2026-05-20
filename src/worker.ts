import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel, type Fetcher } from "./index.js";
import { captunShardName, getTunnelNameFromUrl } from "./routing.js";

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
  private readonly tunnels = new Map<string, Fetcher & Disposable>();

  // The DO's `fetch` only handles the WebSocket upgrade. The upgrade hand-off
  // is special-cased by the Workers runtime around `stub.fetch(...)` — a 101
  // Response with an attached `webSocket` does NOT survive a DO RPC method
  // return (verified empirically: the client side errors with "WebSocket
  // connection failed"). So connect goes through fetch with the tunnel name
  // in a header; everything else uses the `forward` RPC below.
  async fetch(request: Request): Promise<Response> {
    const tunnelName = request.headers.get(TUNNEL_NAME_HEADER);
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    const expected = this.env.CAPTUN_SECRET ? `Bearer ${this.env.CAPTUN_SECRET}` : undefined;
    if (expected && !timingSafeEqual(request.headers.get("authorization") ?? "", expected)) {
      return new Response("Unauthorized\n", { status: 401 });
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

    // In folder mode the first path segment IS the tunnel name; strip it so the
    // tunnel client sees the real forwarded path. In subdomain mode the path
    // is already the forwarded path.
    const url = new URL(request.url);
    const forwardedPath = env.CUSTOM_HOSTNAME ? url.pathname : stripFirstPathSegment(url.pathname);
    url.pathname = forwardedPath;

    const shard = env.CaptunServerShard.getByName(
      captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
    );

    if (forwardedPath === "/__captun-connect") {
      const headers = new Headers(request.headers);
      headers.set(TUNNEL_NAME_HEADER, tunnelName);
      return shard.fetch(new Request(url, { ...request, headers }));
    }
    return shard.forward(tunnelName, new Request(url, request));
  },
} satisfies ExportedHandler<CaptunEnv>;

/** `/foo/bar/baz` -> `/bar/baz`; `/foo` -> `/`. */
function stripFirstPathSegment(pathname: string): string {
  const match = pathname.match(/^\/[^/]+(\/.*)?$/);
  return match?.[1] ?? "/";
}

function timingSafeEqual(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const b = new TextEncoder().encode(expected);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
