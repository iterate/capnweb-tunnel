import {
  captunServerShard,
  createCaptunServerShard,
  createTunnelConnectRequest,
  createTunnelForwardRequest,
  type CaptunServerShard as CaptunServerShardInstance,
} from "../worker.js";
import {
  GATEWAY_CONNECT_QUERY_PARAM,
  getTunnelNameFromUrl,
  getTunnelUrl,
  HOSTED_CAPTUN_HOSTNAME,
  isValidTunnelName,
  RESERVED_TUNNEL_NAMES,
  TUNNEL_CONNECT_DIAGNOSTIC_HEADER,
  TUNNEL_NAME_QUERY_PARAM,
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

export const CaptunServerShard = createCaptunServerShard<HostedCaptunEnv>(
  decidePublicTunnelAdmission,
);
export { HostedRateLimiter };

export type HostedCaptunEnv = PublicGatewayPolicyEnv &
  HostedRateLimitEnv & {
    CaptunServerShard: DurableObjectNamespace<CaptunServerShardInstance<HostedCaptunEnv>>;
    CAPTUN_SECRET?: string;
    SHARD_COUNT?: string;
    CUSTOM_HOSTNAME?: string;
  };

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

    const shard = captunServerShard(env, tunnelName);
    const forwarded = new Request(request.url, request);
    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname: env.CUSTOM_HOSTNAME,
      tunnelName,
    });
    return shard.forward(tunnelName, createTunnelForwardRequest(forwarded, tunnelUrl));
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

  const shard = captunServerShard(env, tunnelName);
  const tunnelUrl = getTunnelUrl({
    reqUrl: request.url,
    customHostname: env.CUSTOM_HOSTNAME,
    tunnelName,
  });
  const connectRequest = createTunnelConnectRequest({ request, tunnelName, tunnelUrl });

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
