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
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard>;
  CAPTUN_TOKEN?: string;
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
};

/** Set by the top-level Worker on the WebSocket-upgrade request so the DO knows the tunnel. */
const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";

type ActiveTunnel = {
  url: string;
  token?: string;
  fetcher: FetcherStub;
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
  private readonly tunnels = new Map<string, ActiveTunnel>();

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

    const expected = this.env.CAPTUN_TOKEN;
    if (expected) {
      // Constant-time comparison to avoid leaking the gateway token via timing.
      const actual = new TextEncoder().encode(connectToken(request) || "");
      const want = new TextEncoder().encode(expected);
      if (!constantTimeEqual(actual, want)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
    }

    const token = expected ? connectToken(request) || undefined : undefined;
    this.tunnels.get(tunnelName)?.fetcher[Symbol.dispose]();
    const { response, fetcher } = acceptFetcherCapability({
      onDisconnect: () => {
        if (this.tunnels.get(tunnelName)?.fetcher === fetcher) this.tunnels.delete(tunnelName);
      },
    });
    const tunnel = { url: tunnelUrl, token, fetcher };
    this.tunnels.set(tunnelName, tunnel);
    queueMicrotask(() => {
      void fetcher.ready({ url: tunnel.url, token: tunnel.token });
    });
    return response;
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

    const shard = env.CaptunServerShard.getByName(
      captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
    );
    const forwarded = new Request(url, request);

    // Keep the canonical tunnel URL attached while crossing into the DO.
    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname: env.CUSTOM_HOSTNAME,
      tunnelName,
    });
    const headers = new Headers(forwarded.headers);
    headers.set(TUNNEL_URL_HEADER, tunnelUrl);
    return shard.forward(tunnelName, new Request(forwarded, { headers }));
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
  const shard = env.CaptunServerShard.getByName(
    captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
  );
  const headers = new Headers(request.headers);
  headers.set(TUNNEL_NAME_HEADER, tunnelName);
  headers.set(TUNNEL_URL_HEADER, tunnelUrl);
  return shard.fetch(new Request(request, { headers }));
}

function isGatewayConnectRequest(request: Request) {
  return new URL(request.url).searchParams.get(GATEWAY_CONNECT_QUERY_PARAM) === "1";
}

function connectToken(request: Request) {
  return new URL(request.url).searchParams.get(CONNECT_TOKEN_QUERY_PARAM);
}

function constantTimeEqual(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index++) {
    diff |= actual[index]! ^ expected[index]!;
  }
  return diff === 0;
}
