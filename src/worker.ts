import { DurableObject } from "cloudflare:workers";
import { CapnwebTunnelServer } from "./server";

interface Env {
  TUNNEL: DurableObjectNamespace<TunnelDurableObject>;
  TUNNEL_SECRET?: string;
  TUNNEL_SHARDS?: string;
}

export class TunnelDurableObject extends DurableObject<Env> {
  private readonly tunnels = new Map<string, CapnwebTunnelServer>();

  fetch(request: Request) {
    const route = tunnelRouteParts("localhost", new URL(request.url).pathname);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });

    let tunnel = this.tunnels.get(route.name);
    if (!tunnel) {
      tunnel = new CapnwebTunnelServer({
        secret: this.env.TUNNEL_SECRET,
        onDisconnect: () => this.tunnels.delete(route.name),
      });
      this.tunnels.set(route.name, tunnel);
    }

    return tunnel.fetch(rewritePath(request, route.path));
  }
}

export default {
  fetch(request: Request, env: Env) {
    const route = tunnelRoute(request);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });
    const shard = tunnelShardName(route.tunnelName, Number(env.TUNNEL_SHARDS ?? 1));
    return env.TUNNEL.getByName(shard).fetch(route.request);
  },
} satisfies ExportedHandler<Env>;

/** Turns an incoming Worker request into a Durable Object name and forwarded request.
 *
 * `my-test.my-tunnels.com/hello` uses `my-test` and keeps `/hello`.
 * `capnweb-tunnel.<cf-account>.workers.dev/my-test/hello` uses `my-test`
 * and forwards `/hello`.
 *
 * See `test/worker.test.ts` for the routing table.
 */
function tunnelRoute(request: Request) {
  const url = new URL(request.url);
  const route = tunnelRouteParts(url.hostname, url.pathname);
  if (!route) return undefined;

  url.pathname = `/${encodeURIComponent(route.name)}${route.path}`;
  return { tunnelName: route.name, request: new Request(url, request) };
}

/** Extracts the tunnel name and forwarded path from just the hostname and path.
 *
 * This is the pure routing rule; keep the examples in `test/worker.test.ts`
 * in sync when changing it.
 */
export function tunnelRouteParts(hostname: string, pathname: string) {
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

export function tunnelShardName(tunnelName: string, shardCount: number) {
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
