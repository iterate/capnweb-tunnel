import { DurableObject } from "cloudflare:workers";
import { acceptFetcherCapability, type FetcherStub } from "./index.js";
import {
  captunShardName,
  CONNECT_TOKEN_QUERY_PARAM,
  GATEWAY_CONNECT_QUERY_PARAM,
  getTunnelNameFromUrl,
  getTunnelUrl,
  isValidTunnelName,
  RESERVED_TUNNEL_NAMES,
  TUNNEL_NAME_QUERY_PARAM,
  TUNNEL_URL_HEADER,
} from "./routing.js";

export type CaptunEnv = {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard<CaptunEnv>>;
  CAPTUN_TOKEN?: string;
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
};

/** Set by the top-level Worker on the WebSocket-upgrade request so the DO knows the tunnel. */
const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";

export type CaptunServerShard<Env = CaptunEnv> = DurableObject<Env> & CaptunServerShardRpc;

export type CaptunServerShardRpc = {
  diagnoseConnect(tunnelName: string, request: Request): Promise<Response>;
  forward(tunnelName: string, request: Request): Promise<Response>;
};

export type CaptunServerShardClass<Env> = {
  new (ctx: DurableObjectState, env: Env): CaptunServerShard<Env>;
};

type CaptunShardBindingEnv<Env> = {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard<Env>>;
  SHARD_COUNT?: string;
};

type ActiveTunnel = {
  url: string;
  token?: string;
  fetcher: FetcherStub;
};

export type TunnelAdmission =
  | { ok: true; token: string | undefined }
  | { ok: false; response: Response };

export type TunnelAdmissionInput<Env> = {
  request: Request;
  env: Env;
  activeToken: string | undefined;
};

export type TunnelAdmissionPolicy<Env> = (
  input: TunnelAdmissionInput<Env>,
) => TunnelAdmission | Promise<TunnelAdmission>;

/**
 * A shard Durable Object owns many named tunnels.
 *
 * `SHARD_COUNT=1` keeps every tunnel in one warm object, which gives the
 * lowest connection latency. Raising `SHARD_COUNT` spreads tunnel names over
 * more objects, which adds cold starts when new shards wake up but gives better
 * aggregate throughput for lots of concurrent large responses.
 */
export const CaptunServerShard = createCaptunServerShard<CaptunEnv>(decideTrustedTunnelAdmission);

export function createCaptunServerShard<Env>(
  decideTunnelAdmission: TunnelAdmissionPolicy<Env>,
): CaptunServerShardClass<Env> {
  return class CaptunServerShard extends DurableObject<Env> implements CaptunServerShardRpc {
    private tunnels = new Map<string, ActiveTunnel>();

    // The DO's `fetch` only handles the WebSocket upgrade. The upgrade hand-off
    // is special-cased by the Workers runtime around `stub.fetch(...)` — a 101
    // Response with an attached `webSocket` does NOT survive a DO RPC method
    // return (verified empirically: the client side errors with "WebSocket
    // connection failed"). So connect goes through fetch with the tunnel name
    // in a header; everything else uses the `forward` RPC below.
    async fetch(request: Request): Promise<Response> {
      const tunnelName = request.headers.get(TUNNEL_NAME_HEADER);
      if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

      const tunnelUrl = request.headers.get(TUNNEL_URL_HEADER);
      if (!tunnelUrl) return new Response("Missing tunnel URL\n", { status: 404 });

      const activeTunnel = this.tunnels.get(tunnelName);
      const admission = await decideTunnelAdmission({
        request,
        env: this.env,
        activeToken: activeTunnel?.token,
      });
      if (!admission.ok) return admission.response;

      activeTunnel?.fetcher[Symbol.dispose]();
      const { response, fetcher } = acceptFetcherCapability({
        onDisconnect: () => {
          if (this.tunnels.get(tunnelName)?.fetcher === fetcher) this.tunnels.delete(tunnelName);
        },
      });
      const tunnel = { url: tunnelUrl, token: admission.token, fetcher };
      this.tunnels.set(tunnelName, tunnel);
      queueMicrotask(() => {
        void fetcher.ready({ url: tunnel.url, token: tunnel.token });
      });
      return response;
    }

    async diagnoseConnect(tunnelName: string, request: Request): Promise<Response> {
      const admission = await decideTunnelAdmission({
        request,
        env: this.env,
        activeToken: this.tunnels.get(tunnelName)?.token,
      });
      if (!admission.ok) return admission.response;
      return new Response(null, {
        status: 204,
        headers: { "cache-control": "no-store" },
      });
    }

    async forward(tunnelName: string, request: Request): Promise<Response> {
      const tunnel = this.tunnels.get(tunnelName)?.fetcher;
      if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
      try {
        return await tunnel.fetch(request);
      } catch {
        return new Response("Tunnel fetch failed\n", { status: 502 });
      }
    }
  };
}

export default {
  fetch(request: Request, env: CaptunEnv): Response | Promise<Response> {
    if ("CAPTUN_SECRET" in env) throw new Error("CAPTUN_SECRET has been renamed to CAPTUN_TOKEN");

    if (isGatewayConnectRequest(request)) {
      return connectTunnel(request, env);
    }

    const tunnelName = getTunnelNameFromUrl({
      customHostname: env.CUSTOM_HOSTNAME,
      url: request.url,
    });
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    // In folder mode the first path segment IS the tunnel name; strip it so the
    // tunnel client sees the real forwarded path. In subdomain mode the path
    // is already the forwarded path.
    const url = new URL(request.url);
    const forwardedPath = env.CUSTOM_HOSTNAME
      ? url.pathname
      : url.pathname.match(/^\/[^/]+(\/.*)?$/)?.[1] || "/";
    url.pathname = forwardedPath;

    if (RESERVED_TUNNEL_NAMES.includes(tunnelName)) {
      return new Response("Reserved Captun tunnel name\n", { status: 404 });
    }

    const shard = captunServerShard(env, tunnelName);
    const forwarded = new Request(url, request);

    // Keep the canonical tunnel URL attached while crossing into the DO.
    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname: env.CUSTOM_HOSTNAME,
      tunnelName,
    });
    return shard.forward(tunnelName, createTunnelForwardRequest(forwarded, tunnelUrl));
  },
} satisfies ExportedHandler<CaptunEnv>;

function connectTunnel(request: Request, env: CaptunEnv) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade\n", { status: 400 });
  }

  const url = new URL(request.url);
  const tunnelName = url.searchParams.get(TUNNEL_NAME_QUERY_PARAM) || "";
  if (!isValidTunnelName(tunnelName) || RESERVED_TUNNEL_NAMES.includes(tunnelName)) {
    return new Response("Missing tunnel name\n", { status: 404 });
  }

  const tunnelUrl = getTunnelUrl({
    reqUrl: request.url,
    customHostname: env.CUSTOM_HOSTNAME,
    tunnelName,
  });
  const shard = captunServerShard(env, tunnelName);
  return shard.fetch(createTunnelConnectRequest({ request, tunnelName, tunnelUrl }));
}

function isGatewayConnectRequest(request: Request) {
  return new URL(request.url).searchParams.get(GATEWAY_CONNECT_QUERY_PARAM) === "1";
}

function connectToken(request: Request) {
  return new URL(request.url).searchParams.get(CONNECT_TOKEN_QUERY_PARAM);
}

function decideTrustedTunnelAdmission(input: TunnelAdmissionInput<CaptunEnv>): TunnelAdmission {
  const expected = input.env.CAPTUN_TOKEN;
  if (expected) {
    // Constant-time comparison to avoid leaking the gateway token via timing.
    const actual = new TextEncoder().encode(connectToken(input.request) || "");
    const want = new TextEncoder().encode(expected);
    if (!constantTimeEqual(actual, want)) {
      return { ok: false, response: new Response("Unauthorized\n", { status: 401 }) };
    }
  }

  return {
    ok: true,
    token: expected ? connectToken(input.request) || undefined : undefined,
  };
}

export function captunServerShard<Env>(
  env: CaptunShardBindingEnv<Env>,
  tunnelName: string,
): DurableObjectStub<CaptunServerShard<Env>> {
  return env.CaptunServerShard.getByName(captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)));
}

export function createTunnelConnectRequest(input: {
  request: Request;
  tunnelName: string;
  tunnelUrl: string;
}): Request {
  const headers = new Headers(input.request.headers);
  headers.set(TUNNEL_NAME_HEADER, input.tunnelName);
  headers.set(TUNNEL_URL_HEADER, input.tunnelUrl);
  return new Request(input.request, { headers });
}

export function createTunnelForwardRequest(request: Request, tunnelUrl: string): Request {
  const headers = new Headers(request.headers);
  headers.set(TUNNEL_URL_HEADER, tunnelUrl);
  return new Request(request, { headers });
}

function constantTimeEqual(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index++) {
    diff |= actual[index]! ^ expected[index]!;
  }
  return diff === 0;
}
