import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel, type Fetcher } from "./index.js";
import {
  captunShardName,
  HOSTED_CAPTUN_HOSTNAME,
  getTunnelNameFromUrl,
  getTunnelUrl,
  RESERVED_HOSTED_SUBDOMAINS,
  TUNNEL_URL_HEADER,
} from "./routing.js";

type CaptunEnv = {
  CaptunServerShard: DurableObjectNamespace<CaptunServerShard>;
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
};

/** Set by the top-level Worker on the WebSocket-upgrade request so the DO knows the tunnel. */
const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";

/**
 * A shard Durable Object owns many named tunnels.
 *
 * `SHARD_COUNT=1` keeps every tunnel in one warm object, which gives the
 * lowest connection latency. Raising `SHARD_COUNT` spreads tunnel names over
 * more objects, which adds cold starts when new shards wake up but gives better
 * aggregate throughput for lots of concurrent large responses.
 */
export class CaptunServerShard extends DurableObject<CaptunEnv> {
  private readonly tunnels = new Map<string, Fetcher & Disposable>();

  // The DO's `fetch` only handles the WebSocket upgrade. The upgrade hand-off
  // is special-cased by the Workers runtime around `stub.fetch(...)` — a 101
  // Response with an attached `webSocket` does NOT survive a DO RPC method
  // return (verified empirically: the client side errors with "WebSocket
  // connection failed"). So connect goes through fetch with the tunnel name
  // in a header; everything else uses the `forward` RPC below.
  async fetch(request: Request): Promise<Response> {
    const tunnelName = request.headers.get(TUNNEL_NAME_HEADER);
    if (!tunnelName) return new Response("Missing tunnel name\n", { status: 404 });

    const expected = this.env.CAPTUN_SECRET ? `Bearer ${this.env.CAPTUN_SECRET}` : undefined;
    if (expected) {
      // Constant-time comparison to avoid leaking the secret via timing.
      const actual = new TextEncoder().encode(request.headers.get("authorization") ?? "");
      const want = new TextEncoder().encode(expected);
      if (actual.length !== want.length || !crypto.subtle.timingSafeEqual(actual, want)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
    }

    this.tunnels.get(tunnelName)?.[Symbol.dispose]();
    const { response, tunnel } = acceptCaptunTunnel({
      onDisconnect: () => {
        if (this.tunnels.get(tunnelName) === tunnel) this.tunnels.delete(tunnelName);
      },
    });
    this.tunnels.set(tunnelName, tunnel);
    return response;
  }

  async forward(tunnelName: string, request: Request): Promise<Response> {
    const tunnel = this.tunnels.get(tunnelName);
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
    const hostedResponse = hostedCaptunResponse(request, env);
    if (hostedResponse) return hostedResponse;

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
      : (url.pathname.match(/^\/[^/]+(\/.*)?$/)?.[1] ?? "/");
    url.pathname = forwardedPath;

    const shard = env.CaptunServerShard.getByName(
      captunShardName(tunnelName, Number(env.SHARD_COUNT || 1)),
    );

    const forwarded = new Request(url, request);

    if (forwardedPath === "/__captun-connect") {
      const headers = new Headers(forwarded.headers);
      headers.set(TUNNEL_NAME_HEADER, tunnelName);
      return shard.fetch(new Request(forwarded, { headers }));
    }

    // Advertise the canonical tunnel URL back to the tunnel client. The CLI
    // reads this so it doesn't have to mirror the Worker's routing convention.
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

function hostedCaptunResponse(request: Request, env: CaptunEnv): Response | undefined {
  if (env.CUSTOM_HOSTNAME !== HOSTED_CAPTUN_HOSTNAME) return undefined;

  const url = new URL(request.url);
  if (url.hostname === HOSTED_CAPTUN_HOSTNAME) {
    return Response.redirect(
      `https://www.${HOSTED_CAPTUN_HOSTNAME}${url.pathname}${url.search}`,
      308,
    );
  }

  const suffix = `.${HOSTED_CAPTUN_HOSTNAME}`;
  if (!url.hostname.endsWith(suffix)) return undefined;

  const labels = url.hostname.slice(0, -suffix.length).split(".");
  const subdomain = labels[labels.length - 1] || "";
  if (subdomain === "www") {
    return new Response(WWW_LANDING_PAGE, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (RESERVED_HOSTED_SUBDOMAINS.includes(subdomain)) {
    return new Response("Reserved captun.sh subdomain\n", { status: 404 });
  }
}

const WWW_LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>captun</title>
  <style>
    body { max-width: 720px; margin: 64px auto; padding: 0 20px; font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111; background: #fff; }
    h1 { font-size: 28px; margin: 0 0 24px; }
    h2 { font-size: 16px; margin: 28px 0 8px; }
    pre { padding: 12px 14px; overflow-x: auto; background: #f4f4f4; border: 1px solid #ddd; }
    a { color: #0645ad; }
  </style>
</head>
<body>
  <h1>captun</h1>
  <p>A tiny public tunnel for local HTTP servers.</p>
  <p>Run this in a project with something listening on port 3000:</p>
  <pre>npx captun 3000</pre>
  <p>You get a URL like:</p>
  <pre>https://abc123.captun.sh</pre>
  <p>Requests to that URL are forwarded to your local server until you stop the process.</p>

  <h2>From code</h2>
  <pre>import { createCaptunTunnel } from "captun";

const tunnel = await createCaptunTunnel({
  fetch: () => new Response("hello from my machine"),
});

console.log(tunnel.url);</pre>

  <h2>Bring your own Cloudflare account</h2>
  <pre>npx captun deploy</pre>
  <p>Source: <a href="https://github.com/iterate/captun">github.com/iterate/captun</a></p>
</body>
</html>`;
