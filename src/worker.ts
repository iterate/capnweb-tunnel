import { CapnwebTunnelServer } from "./server";

interface Env {
  TUNNEL: DurableObjectNamespace;
}

export class TunnelDurableObject implements DurableObject {
  private readonly tunnel = new CapnwebTunnelServer();

  fetch(request: Request) {
    return this.tunnel.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env) {
    const route = tunnelRoute(request);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });
    return env.TUNNEL.get(env.TUNNEL.idFromName(route.name)).fetch(route.request);
  },
};

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
  if (route.path === url.pathname) return { name: route.name, request };

  url.pathname = route.path;
  return { name: route.name, request: new Request(url, request) };
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
    return { name: decodeURIComponent(name), path: pathname };
  }
  const [name, ...rest] = pathname.split("/").filter(Boolean);
  if (!name || name === "__connect") return undefined;
  return { name: decodeURIComponent(name), path: `/${rest.join("/")}` };
}

/** Chooses folder routing for vanilla Worker hosts and apex/local dev hosts. */
function usesFolderRouting(hostname: string) {
  return hostname === "localhost"
    || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    || hostname.endsWith(".workers.dev")
    || hostname.startsWith("tunnels.")
    || hostname.split(".").length < 3;
}
