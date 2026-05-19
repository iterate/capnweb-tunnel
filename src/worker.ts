import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel } from "./server.js";
import type { CaptunServerTunnel } from "./types.js";
import {
  captunActiveTunnelSetCookie,
  captunCookieWithoutRoutingCookie,
  captunRequestRouteParts,
  captunRouteParts,
  captunShardName,
} from "./worker-routing.js";

type CaptunEnv = Env & {
  CAPTUN_SECRET?: string;
  CAPTUN_SHARDS?: string;
};

/**
 * A shard Durable Object owns many named tunnels.
 *
 * `CAPTUN_SHARDS=1` keeps every tunnel in one warm object, which gives the
 * lowest connection latency. Raising `CAPTUN_SHARDS` spreads tunnel names over
 * more objects, which adds cold starts when new shards wake up but gives better
 * aggregate throughput for lots of concurrent large responses.
 */
export class CaptunServerShard extends DurableObject<CaptunEnv> {
  private readonly tunnels = new Map<string, CaptunServerTunnel>();

  fetch(request: Request) {
    const route = captunRouteParts("localhost", new URL(request.url).pathname);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });

    let routedRequest = request;
    const routedUrl = new URL(request.url);
    if (routedUrl.pathname !== route.path) {
      routedUrl.pathname = route.path;
      routedRequest = new Request(routedUrl, request);
    }

    if (route.path === "/__captun-connect") {
      const expectedAuthorization = this.env.CAPTUN_SECRET
        ? `Bearer ${this.env.CAPTUN_SECRET}`
        : undefined;
      const actualAuthorization = new TextEncoder().encode(
        routedRequest.headers.get("authorization") || "",
      );
      const encodedExpectedAuthorization = new TextEncoder().encode(expectedAuthorization || "");
      if (
        expectedAuthorization &&
        (actualAuthorization.length !== encodedExpectedAuthorization.length ||
          !crypto.subtle.timingSafeEqual(actualAuthorization, encodedExpectedAuthorization))
      ) {
        return new Response("Unauthorized\n", { status: 401 });
      }

      this.tunnels.get(route.name)?.[Symbol.dispose]();
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (this.tunnels.get(route.name) === tunnel) {
            this.tunnels.delete(route.name);
          }
        },
      });
      this.tunnels.set(route.name, tunnel);
      return response;
    }

    const tunnel = this.tunnels.get(route.name);
    if (!tunnel) return new Response("No tunnel client connected\n", { status: 503 });
    return tunnel.fetch(routedRequest);
  }
}

export default {
  async fetch(request: Request, env: CaptunEnv) {
    const route = captunRoute(request);
    if (!route) return new Response("Missing tunnel name\n", { status: 404 });

    if (route.kind === "select-active-tunnel") {
      return selectActiveTunnelResponse(request, route.tunnelName);
    }

    const shard = captunShardName(route.tunnelName, Number(env.CAPTUN_SHARDS || 1));
    const response = await env.CaptunServerShard.getByName(shard).fetch(route.request);
    return route.rootedByCookie ? withCookieVary(response) : response;
  },
} satisfies ExportedHandler<CaptunEnv>;

/** Turns an incoming Worker request into a Durable Object name and forwarded request. */
function captunRoute(request: Request) {
  const url = new URL(request.url);
  const route = captunRequestRouteParts(
    url.hostname,
    url.pathname,
    request.headers.get("cookie") || "",
  );
  if (!route) return undefined;
  if (route.kind === "select-active-tunnel") {
    return { kind: route.kind, tunnelName: route.name };
  }

  url.pathname = `/${encodeURIComponent(route.name)}${route.path}`;
  return {
    kind: route.kind,
    tunnelName: route.name,
    rootedByCookie: route.rootedByCookie,
    request: requestWithUrlAndStrippedRoutingCookie(url, request),
  };
}

/** Sets the active tunnel cookie and sends browsers back to the Worker root. */
function selectActiveTunnelResponse(request: Request, tunnelName: string) {
  const url = new URL(request.url);
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location: "/",
      "set-cookie": captunActiveTunnelSetCookie(tunnelName, url.protocol),
    },
  });
}

/** Clones a request to the Durable Object URL without leaking Captun's cookie to origins. */
function requestWithUrlAndStrippedRoutingCookie(url: URL, request: Request) {
  const headers = new Headers(request.headers);
  const cookieHeader = captunCookieWithoutRoutingCookie(headers.get("cookie") || "");
  if (cookieHeader) headers.set("cookie", cookieHeader);
  else headers.delete("cookie");

  const init: RequestInit = {
    headers,
    method: request.method,
    redirect: request.redirect,
    signal: request.signal,
  };
  if (request.body && request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  return new Request(url, init);
}

/** Marks cookie-selected responses as varying by the browser routing cookie. */
function withCookieVary(response: Response) {
  const headers = new Headers(response.headers);
  const vary = headers.get("vary");
  if (!vary) headers.set("vary", "Cookie");
  else if (
    vary.trim() !== "*" &&
    !vary.split(",").some((part) => part.trim().toLowerCase() === "cookie")
  ) {
    headers.set("vary", `${vary}, Cookie`);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
