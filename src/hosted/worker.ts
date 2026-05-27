import {
  captunServerShard,
  createTunnelConnectRequest,
  createTunnelForwardRequest,
  CaptunServerShard as CloudflareTunnelGatewayShard,
  type TunnelAdmission,
  type TunnelAdmissionInput,
} from "../server/worker.js";
import {
  CONNECT_TOKEN_QUERY_PARAM,
  GATEWAY_CONNECT_QUERY_PARAM,
  TUNNEL_CONNECT_DIAGNOSTIC_HEADER,
  TUNNEL_NAME_QUERY_PARAM,
} from "../index.js";
import {
  getTunnelNameFromUrl,
  getTunnelUrl,
  isValidTunnelName,
} from "../server/tunnel-addressing.js";
import {
  HostedRateLimiter,
  hostedRateLimitDiagnosticResponse,
  hostedRateLimitResponse,
  type HostedRateLimitEnv,
} from "./rate-limit.js";
import { isHostedReservedTunnelName } from "./reserved-tunnel-names.js";
import { hostedCaptunResponse, HOSTED_CAPTUN_HOSTNAME, isLoopbackHostname } from "./site.js";

export class CaptunServerShard extends CloudflareTunnelGatewayShard<HostedCaptunEnv> {
  protected decideTunnelAdmission(input: TunnelAdmissionInput<HostedCaptunEnv>): TunnelAdmission {
    const configuredToken = input.env.CAPTUN_TOKEN;
    const token = connectToken(input.request) || undefined;
    if (configuredToken) {
      if (!token || !constantTimeEqual(token, configuredToken)) {
        return { ok: false, response: reject("Unauthorized\n", 401) };
      }
      return { ok: true, token };
    }

    if (!token) return { ok: false, response: reject("Missing tunnel token\n", 400) };
    if (!/^[a-zA-Z0-9._~-]{1,128}$/.test(token)) {
      return { ok: false, response: reject("Invalid tunnel token\n", 400) };
    }
    if (input.activeToken && input.activeToken !== token) {
      return { ok: false, response: reject("Tunnel name is already connected\n", 409) };
    }

    return { ok: true, token };
  }
}

export { HostedRateLimiter };

export type HostedCaptunEnv = HostedRateLimitEnv & {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard>;
  CAPTUN_TOKEN?: string;
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

    const customHostname = customHostnameForRequest(request, env);
    const tunnelName = getTunnelNameFromUrl({
      customHostname,
      url: request.url,
    });
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    if (isHostedReservedTunnelName(tunnelName)) {
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
    const forwarded = createForwardedRequest(request, customHostname);
    const tunnelUrl = getTunnelUrl({
      reqUrl: request.url,
      customHostname,
      tunnelName,
    });
    const response = await shard.forward(
      tunnelName,
      createTunnelForwardRequest(forwarded, tunnelUrl),
    );
    return stripSetCookieHeadersOutsideTunnel(response, new URL(tunnelUrl).hostname);
  },
} satisfies ExportedHandler<HostedCaptunEnv>;

async function connectTunnel(request: Request, env: HostedCaptunEnv) {
  const diagnostic = isConnectDiagnostic(request);
  if (!diagnostic && request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade\n", { status: 400 });
  }

  const url = new URL(request.url);
  const tunnelName = url.searchParams.get(TUNNEL_NAME_QUERY_PARAM) || "";
  if (!isValidTunnelName(tunnelName) || isHostedReservedTunnelName(tunnelName)) {
    return new Response("Missing tunnel name\n", { status: 404 });
  }

  const customHostname = customHostnameForRequest(request, env);
  const shard = captunServerShard(env, tunnelName);
  const tunnelUrl = getTunnelUrl({
    reqUrl: request.url,
    customHostname,
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

function connectToken(request: Request) {
  return new URL(request.url).searchParams.get(CONNECT_TOKEN_QUERY_PARAM);
}

function customHostnameForRequest(request: Request, env: HostedCaptunEnv) {
  const url = new URL(request.url);
  if (isLoopbackHostname(url.hostname)) return undefined;
  return env.CUSTOM_HOSTNAME;
}

function createForwardedRequest(request: Request, customHostname: string | undefined) {
  const url = new URL(request.url);
  if (!customHostname) {
    url.pathname = url.pathname.match(/^\/[^/]+(\/.*)?$/)?.[1] || "/";
  }
  return new Request(url, request);
}

function stripSetCookieHeadersOutsideTunnel(response: Response, tunnelHostname: string) {
  const setCookies = setCookieHeaders(response.headers);
  if (setCookies.length === 0) return response;

  const safeCookies = setCookies.filter((cookie) =>
    setCookieIsScopedToTunnel(cookie, tunnelHostname),
  );
  if (safeCookies.length === setCookies.length) return response;

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  for (const cookie of safeCookies) headers.append("set-cookie", cookie);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function setCookieHeaders(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(headers) : [];
  if (cookies.length > 0) return cookies;

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function setCookieIsScopedToTunnel(cookie: string, tunnelHostname: string) {
  const domains = setCookieDomains(cookie);
  if (domains.length === 0) return true;

  // Add captun.sh to the public suffix list if/when people are using this.
  return domains.every(
    (domain) => domain === tunnelHostname || domain.endsWith(`.${tunnelHostname}`),
  );
}

function setCookieDomains(cookie: string) {
  const attributes = cookie.split(";").slice(1);
  const domains: string[] = [];
  for (const attribute of attributes) {
    const [name, ...valueParts] = attribute.split("=");
    if (name?.trim().toLowerCase() !== "domain") continue;
    domains.push(valueParts.join("=").trim().replace(/^\./, "").toLowerCase());
  }
  return domains;
}

function reject(body: string, status: number) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function constantTimeEqual(actual: string, expected: string) {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  let diff = 0;
  for (let index = 0; index < actualBytes.length; index++) {
    diff |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return diff === 0;
}
