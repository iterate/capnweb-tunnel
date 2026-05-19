import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel } from "./server.js";
import type { CaptunServerTunnel } from "./types.js";
import { captunRouteParts, captunShardName } from "./worker-routing.js";

type CaptunEnv = Env & {
  CAPTUN_SECRET?: string;
  CAPTUN_SHARDS?: string;
};

/**
 * A shard Durable Object owns many named tunnels.
 *
 * `CAPTUN_SHARDS=1` keeps every tunnel in one warm object, which gives the
 * lowest connection latency. Raising `CAPTUN_SHARDS` spreads tunnel names over
 * more objects, which adds cold starts when new shards wake up but gives better
 * aggregate throughput for lots of concurrent large responses.
 */
export class CaptunServerShard extends DurableObject<CaptunEnv> {
  private readonly tunnels = new Map<string, CaptunServerTunnel>();

  fetch(request: Request) {
    const route = captunRouteParts("localhost", new URL(request.url).pathname);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });

    let routedRequest = request;
    const routedUrl = new URL(request.url);
    if (routedUrl.pathname !== route.path) {
      routedUrl.pathname = route.path;
      routedRequest = new Request(routedUrl, request);
    }

    if (route.path === "/__captun-connect") {
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

      this.tunnels.get(route.name)?.[Symbol.dispose]();
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (this.tunnels.get(route.name) === tunnel) {
            this.tunnels.delete(route.name);
          }
        },
      });
      this.tunnels.set(route.name, tunnel);
      return response;
    }

    const tunnel = this.tunnels.get(route.name);
    if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
    return tunnel.fetch(routedRequest);
  }
}

export default {
  fetch(request: Request, env: CaptunEnv) {
    const route = captunRoute(request);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });
    const shard = captunShardName(route.tunnelName, Number(env.CAPTUN_SHARDS || 1));
    return env.CaptunServerShard.getByName(shard).fetch(route.request);
  },
} satisfies ExportedHandler<CaptunEnv>;

/** Turns an incoming Worker request into a Durable Object name and forwarded request. */
function captunRoute(request: Request) {
  const url = new URL(request.url);
  const route = captunRouteParts(url.hostname, url.pathname);
  if (!route) return undefined;

  url.pathname = `/${encodeURIComponent(route.name)}${route.path}`;
  return { tunnelName: route.name, request: new Request(url, request) };
}
