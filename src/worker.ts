import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel } from "./server";
import type { CaptunServerTunnel } from "./types";

interface CaptunEnv {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard>;
  CAPTUN_SECRET?: string;
  CAPTUN_SHARDS?: string;
}

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
    const route = CaptunRouteParts("localhost", new URL(request.url).pathname);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });

    const routedRequest = rewritePath(request, route.path);
    if (route.path === "/__connect") {
      if (!connectHeadersMatch(routedRequest.headers, this.env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }

      this.tunnels.get(route.name)?.[Symbol.dispose]();
      // Accepting the WebSocket gives us the 101 response for this connect
      // request, plus a tunnel handle backed by the client's main-object stub.
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
    const shard = CaptunShardName(route.tunnelName, Number(env.CAPTUN_SHARDS ?? 1));
    return env.CaptunServerShard.getByName(shard).fetch(route.request);
  },
} satisfies ExportedHandler<CaptunEnv>;

/** Turns an incoming Worker request into a Durable Object name and forwarded request.
 *
 * `my-test.my-tunnels.com/hello` uses `my-test` and keeps `/hello`.
 * `captun.<cf-account>.workers.dev/my-test/hello` uses `my-test`
 * and forwards `/hello`.
 *
 * See `test/worker.test.ts` for the routing table.
 */
function captunRoute(request: Request) {
  const url = new URL(request.url);
  const route = CaptunRouteParts(url.hostname, url.pathname);
  if (!route) return undefined;

  url.pathname = `/${encodeURIComponent(route.name)}${route.path}`;
  return { tunnelName: route.name, request: new Request(url, request) };
}

/** Extracts the tunnel name and forwarded path from just the hostname and path.
 *
 * This is the pure routing rule; keep the examples in `test/worker.test.ts`
 * in sync when changing it.
 */
export function CaptunRouteParts(hostname: string, pathname: string) {
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

export function CaptunShardName(tunnelName: string, shardCount: number) {
  if (!Number.isFinite(shardCount) || shardCount <= 1) return "tunnel-shard-0";
  let hash = 2166136261;
  for (let index = 0; index < tunnelName.length; index++) {
    hash ^= tunnelName.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tunnel-shard-${(hash >>> 0) % Math.floor(shardCount)}`;
}

/** Chooses folder routing for vanilla Worker hosts and apex/local dev hosts. */
function usesFolderRouting(hostname: string) {
  return hostname === "localhost"
    || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    || hostname.endsWith(".workers.dev")
    || hostname.startsWith("tunnels.")
    || hostname.split(".").length < 3;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function rewritePath(request: Request, pathname: string) {
  const url = new URL(request.url);
  if (url.pathname === pathname) return request;
  url.pathname = pathname;
  return new Request(url, request);
}

function connectHeadersMatch(headers: Headers, env: CaptunEnv) {
  if (!env.CAPTUN_SECRET) return true;
  return constantTimeEqual(headers.get("authorization") ?? "", `Bearer ${env.CAPTUN_SECRET}`);
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index++) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}
