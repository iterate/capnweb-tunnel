import { CapnwebTunnelServer } from "./server";

interface Env {
  TUNNEL: DurableObjectNamespace;
  TUNNEL_USERNAME?: string;
  TUNNEL_PASSWORD?: string;
}

function tunnelName(request: Request): string | undefined {
  const url = new URL(request.url);
  const wildcardName = url.hostname.match(/^([^.]+)\.tunnels\./)?.[1];
  if (wildcardName) return decodeURIComponent(wildcardName);

  const pathName = url.pathname.split("/").filter(Boolean)[0];
  return pathName ? decodeURIComponent(pathName) : undefined;
}

function tunnelObject(request: Request, env: Env): DurableObjectStub | undefined {
  const name = tunnelName(request);
  return name ? env.TUNNEL.get(env.TUNNEL.idFromName(name)) : undefined;
}

function authorized(request: Request, env: Env): boolean {
  if (!env.TUNNEL_USERNAME && !env.TUNNEL_PASSWORD) return true;
  if (!env.TUNNEL_USERNAME || !env.TUNNEL_PASSWORD) return false;
  return request.headers.get("authorization") ===
    `Basic ${btoa(`${env.TUNNEL_USERNAME}:${env.TUNNEL_PASSWORD}`)}`;
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
