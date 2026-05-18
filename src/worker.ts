import { CapnwebTunnelServer } from "./server";

interface Env {
  TUNNEL: DurableObjectNamespace;
}

export class TunnelDurableObject implements DurableObject {
  private readonly tunnel = new CapnwebTunnelServer();

  fetch(request: Request): Promise<Response> {
    return this.tunnel.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const route = tunnelRoute(request);
    if (!route) return Promise.resolve(new Response("Missing tunnel name\n", { status: 404 }));
    return env.TUNNEL.get(env.TUNNEL.idFromName(route.name)).fetch(route.request);
  },
} satisfies ExportedHandler<Env>;

function tunnelRoute(request: Request): { name: string; request: Request } | undefined {
  const url = new URL(request.url);
  const subdomainName = url.hostname.match(/^([^.]+)\.tunnels\./)?.[1];
  if (subdomainName) return { name: decodeURIComponent(subdomainName), request };

  const [name, ...rest] = url.pathname.split("/").filter(Boolean);
  if (!name) return undefined;
  url.pathname = `/${rest.join("/")}`;
  return { name: decodeURIComponent(name), request: new Request(url, request) };
}
