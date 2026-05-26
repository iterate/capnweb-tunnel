import { DurableObject } from "cloudflare:workers";
import { acceptFetcherCapability, type FetcherStub } from "../index.js";
import {
  captunShardName,
  GATEWAY_CONNECT_QUERY_PARAM,
  getTunnelNameFromUrl,
  getTunnelUrl,
  HOSTED_CAPTUN_HOSTNAME,
  isValidTunnelName,
  RESERVED_TUNNEL_NAMES,
  TUNNEL_CONNECT_DIAGNOSTIC_HEADER,
  TUNNEL_NAME_QUERY_PARAM,
  TUNNEL_URL_HEADER,
} from "../routing.js";
import {
  decidePublicTunnelAdmission,
  type PublicGatewayPolicyEnv,
} from "./public-gateway-policy.js";
import {
  HostedRateLimiter,
  hostedRateLimitDiagnosticResponse,
  hostedRateLimitResponse,
  type HostedRateLimitEnv,
} from "./rate-limit.js";
import { hostedCaptunResponse } from "./site.js";

export { HostedRateLimiter };

export type HostedCaptunEnv = PublicGatewayPolicyEnv &
  HostedRateLimitEnv & {
    CaptunServerShard: DurableObjectNamespace<CaptunServerShard>;
    CAPTUN_SECRET?: string;
    SHARD_COUNT?: string;
    CUSTOM_HOSTNAME?: string;
  };

const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";

type ActiveTunnel = {
  url: string;
  token?: string;
  fetcher: FetcherStub;
};

export class CaptunServerShard extends DurableObject<HostedCaptunEnv> {
  private tunnels = new Map<string, ActiveTunnel>();

  async fetch(request: Request): Promise<Response> {
    const tunnelName = request.headers.get(TUNNEL_NAME_HEADER);
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    const tunnelUrl = request.headers.get(TUNNEL_URL_HEADER);
    if (!tunnelUrl) return new Response("Missing tunnel URL\n", { status: 404 });

    const activeTunnel = this.tunnels.get(tunnelName);
    const admission = decidePublicTunnelAdmission({
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

  diagnoseConnect(tunnelName: string, request: Request): Response {
    const admission = decidePublicTunnelAdmission({
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
}

export default {
  async fetch(request: Request, env: HostedCaptunEnv): Promise<Response> {
    if ("CAPTUN_SECRET" in env) throw new Error("CAPTUN_SECRET has been renamed to CAPTUN_TOKEN");
    if (env.CUSTOM_HOSTNAME !== HOSTED_CAPTUN_HOSTNAME) {
      throw new Error("Hosted Captun Worker requires CUSTOM_HOSTNAME=captun.sh");
    }

    if (isGatewayConnectRequest(request)) {
      return connectTunnel(request, env);
    }

    const hostedResponse = hostedCaptunResponse(request);
    if (hostedResponse) return hostedResponse;

    const tunnelName = getTunnelNameFromUrl({
      customHostname: env.CUSTOM_HOSTNAME,
      url: request.url,
    });
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    if (RESERVED_TUNNEL_NAMES.includes(tunnelName)) {
      return new Response("Reserved Captun tunnel name\n", { status: 404 });
    }

    const rateLimited = await hostedRateLimitResponse({
      env,
      request,
      tunnelName,
      kind: "request",
    });
    if (rateLimited) return rateLimited;

    const shard = env.CaptunServerShard.getByName(
      captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
    );
    const forwarded = new Request(request.url, request);
    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname: env.CUSTOM_HOSTNAME,
      tunnelName,
    });
    const headers = new Headers(forwarded.headers);
    headers.set(TUNNEL_URL_HEADER, tunnelUrl);
    return shard.forward(tunnelName, new Request(forwarded, { headers }));
  },
} satisfies ExportedHandler<HostedCaptunEnv>;

async function connectTunnel(request: Request, env: HostedCaptunEnv) {
  const diagnostic = isConnectDiagnostic(request);
  if (!diagnostic && request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade\n", { status: 400 });
  }

  const url = new URL(request.url);
  const tunnelName = url.searchParams.get(TUNNEL_NAME_QUERY_PARAM) || "";
  if (!isValidTunnelName(tunnelName) || RESERVED_TUNNEL_NAMES.includes(tunnelName)) {
    return new Response("Missing tunnel name\n", { status: 404 });
  }

  const shard = env.CaptunServerShard.getByName(
    captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
  );
  const tunnelUrl = getTunnelUrl({
    reqUrl: request.url,
    customHostname: env.CUSTOM_HOSTNAME,
    tunnelName,
  });
  const headers = new Headers(request.headers);
  headers.set(TUNNEL_NAME_HEADER, tunnelName);
  headers.set(TUNNEL_URL_HEADER, tunnelUrl);
  const connectRequest = new Request(request, { headers });

  if (diagnostic) {
    const rateLimited = await hostedRateLimitDiagnosticResponse({
      env,
      request,
      tunnelName,
      kind: "connect",
    });
    if (rateLimited) return rateLimited;
    return shard.diagnoseConnect(tunnelName, connectRequest);
  }

  const rateLimited = await hostedRateLimitResponse({
    env,
    request,
    tunnelName,
    kind: "connect",
  });
  if (rateLimited) return rateLimited;

  return shard.fetch(connectRequest);
}

function isGatewayConnectRequest(request: Request) {
  return new URL(request.url).searchParams.get(GATEWAY_CONNECT_QUERY_PARAM) === "1";
}

function isConnectDiagnostic(request: Request) {
  if (request.headers.get("upgrade") === "websocket") return false;
  return request.headers.get(TUNNEL_CONNECT_DIAGNOSTIC_HEADER) === "1";
}
