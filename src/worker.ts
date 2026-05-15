import { CapnwebTunnelServer } from "./server";

interface Env {
  TUNNEL: DurableObjectNamespace;
  TUNNEL_API_SECRET?: string;
}

const TUNNEL_PREFIX = "/__capnweb_tunnels/";

function tunnelObject(request: Request, env: Env): DurableObjectStub | undefined {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(TUNNEL_PREFIX)) return undefined;
  const name = url.pathname.slice(TUNNEL_PREFIX.length).split("/")[0];
  if (!name) return undefined;
  return env.TUNNEL.get(env.TUNNEL.idFromName(decodeURIComponent(name)));
}

function authorized(request: Request, env: Env): boolean {
  return !env.TUNNEL_API_SECRET ||
    request.headers.get("authorization") === `Bearer ${env.TUNNEL_API_SECRET}`;
}

export class TunnelDurableObject implements DurableObject {
  private readonly tunnel = new CapnwebTunnelServer();

  fetch(request: Request): Promise<Response> {
    return this.tunnel.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) {
      return Promise.resolve(new Response("Unauthorized\n", { status: 401 }));
    }
    return tunnelObject(request, env)?.fetch(request) ?? Promise.resolve(new Response("Not found\n", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
