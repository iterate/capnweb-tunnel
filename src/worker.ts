import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel, type Fetcher } from "./index.js";
import { captunShardName, getTunnelNameFromUrl } from "./routing.js";

type CaptunEnv = Env & {
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
};

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

  async fetch(request: Request) {
    // The top-level Worker normalizes incoming requests so the DO always sees
    // `/<encoded-name><forwarded-path>`. Decode the name and recover the path.
    const url = new URL(request.url);
    const [encodedName, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!encodedName) return new Response("Missing tunnel name\n", { status: 404 });
    const name = decodeURIComponent(encodedName);
    const forwardedPath = `/${rest.join("/")}`;

    let routedRequest = request;
    if (url.pathname !== forwardedPath) {
      url.pathname = forwardedPath;
      routedRequest = new Request(url, request);
    }

    if (forwardedPath === "/__captun-connect") {
      const expectedAuthorization = this.env.CAPTUN_SECRET
        ? `Bearer ${this.env.CAPTUN_SECRET}`
        : undefined;
      const actualAuthorization = new TextEncoder().encode(
        routedRequest.headers.get("authorization") || "",
      );
      const encodedExpectedAuthorization = new TextEncoder().encode(expectedAuthorization || "");
      if (
        expectedAuthorization &&
        (actualAuthorization.length !== encodedExpectedAuthorization.length ||
          !crypto.subtle.timingSafeEqual(actualAuthorization, encodedExpectedAuthorization))
      ) {
        return new Response("Unauthorized\n", { status: 401 });
      }

      this.tunnels.get(name)?.[Symbol.dispose]();
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (this.tunnels.get(name) === tunnel) {
            this.tunnels.delete(name);
          }
        },
      });
      this.tunnels.set(name, tunnel);
      return response;
    }

    const tunnel = this.tunnels.get(name);
    if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
    try {
      return await tunnel.fetch(routedRequest);
    } catch {
      return new Response("Tunnel fetch failed\n", { status: 502 });
    }
  }
}

export default {
  fetch(request: Request, env: CaptunEnv) {
    const url = new URL(request.url);
    const name = getTunnelNameFromUrl({ customHostname: env.CUSTOM_HOSTNAME, url: request.url });
    if (!name) return new Response("Missing tunnel name\n", { status: 404 });

    // In folder mode the first path segment IS the tunnel name; strip it so the
    // DO and the tunnel client see the real forwarded path. In subdomain mode
    // the path is already the forwarded path.
    const forwardedPath = env.CUSTOM_HOSTNAME ? url.pathname : stripFirstPathSegment(url.pathname);

    // Pass through to the DO using the `/<encoded-name><path>` convention so
    // the DO knows which tunnel to dispatch to.
    url.pathname = `/${encodeURIComponent(name)}${forwardedPath}`;
    const forwardedRequest = new Request(url, request);

    const shard = captunShardName(name, Number(env.SHARD_COUNT || 1));
    return env.CaptunServerShard.getByName(shard).fetch(forwardedRequest);
  },
} satisfies ExportedHandler<CaptunEnv>;

/** `/foo/bar/baz` -> `/bar/baz`; `/foo` -> `/`. */
function stripFirstPathSegment(pathname: string): string {
  const match = pathname.match(/^\/[^/]+(\/.*)?$/);
  return match?.[1] ?? "/";
}
