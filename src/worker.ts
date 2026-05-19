import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel } from "./server.ts";
import type { CaptunServerTunnel } from "./types.ts";

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

    if (route.path === "/__connect") {
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

/** Extracts the tunnel name and forwarded path from just the hostname and path. */
function captunRouteParts(hostname: string, pathname: string) {
  if (!usesFolderRouting(hostname)) {
    const [name] = hostname.split(".");
    if (!name) return undefined;
    const decodedName = safeDecodeURIComponent(name);
    return decodedName ? { name: decodedName, path: pathname } : undefined;
  }
  const [name, ...rest] = pathname.split("/").filter(Boolean);
  if (!name || name === "__connect") return undefined;
  const decodedName = safeDecodeURIComponent(name);
  return decodedName ? { name: decodedName, path: `/${rest.join("/")}` } : undefined;
}

/** Maps a tunnel name to a stable Durable Object shard name. */
function captunShardName(tunnelName: string, shardCount: number) {
  if (!Number.isFinite(shardCount) || shardCount <= 1) return "tunnel-shard-0";
  let hash = 2166136261;
  for (let index = 0; index < tunnelName.length; index++) {
    hash ^= tunnelName.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tunnel-shard-${(hash >>> 0) % Math.floor(shardCount)}`;
}

/** Chooses folder routing for Worker preview hosts, apex domains, and local dev. */
function usesFolderRouting(hostname: string) {
  return (
    hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname.endsWith(".workers.dev") ||
    hostname.startsWith("tunnels.") ||
    hostname.split(".").length < 3
  );
}

/** Decodes a route segment, returning undefined for malformed percent escapes. */
function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
