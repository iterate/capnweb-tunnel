import { DurableObject } from "cloudflare:workers";
import { decideTunnelAdmission } from "./hosted-admission.js";
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
  HostedRateLimiter?: DurableObjectNamespace<HostedRateLimiter>;
  CAPTUN_SECRET?: string;
  SHARD_COUNT?: string;
  CUSTOM_HOSTNAME?: string;
  HOSTED_RATE_LIMIT_WINDOW_SECONDS?: string;
  HOSTED_CONNECTS_PER_IP_PER_WINDOW?: string;
  HOSTED_REQUESTS_PER_IP_PER_WINDOW?: string;
  HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW?: string;
  HOSTED_RATE_LIMIT_DISABLED?: string;
};

/** Set by the top-level Worker on the WebSocket-upgrade request so the DO knows the tunnel. */
const TUNNEL_NAME_HEADER = "x-captun-tunnel-name";

const DEFAULT_HOSTED_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_HOSTED_CONNECTS_PER_IP_PER_WINDOW = 30;
const DEFAULT_HOSTED_REQUESTS_PER_IP_PER_WINDOW = 600;
const DEFAULT_HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW = 1200;

type HostedRateLimitKind = "connect" | "request";

type HostedRateLimitInput = { limit: number; windowSeconds: number };

type HostedRateLimitResult = { ok: true } | { ok: false; limit: number; retryAfterSeconds: number };

type HostedRateLimitBucket = {
  count: number;
  resetAt: number;
};

type ActiveTunnel = {
  fetcher: Fetcher & Disposable;
  ownerToken?: string;
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

    const activeTunnel = this.tunnels.get(tunnelName);
    const admission = decideTunnelAdmission({
      request,
      env: this.env,
      activeOwnerToken: activeTunnel?.ownerToken,
    });
    if (!admission.ok) return admission.response;

    activeTunnel?.fetcher[Symbol.dispose]();
    const { response, tunnel } = acceptCaptunTunnel({
      onDisconnect: () => {
        if (this.tunnels.get(tunnelName)?.fetcher === tunnel) this.tunnels.delete(tunnelName);
      },
    });
    this.tunnels.set(tunnelName, { fetcher: tunnel, ownerToken: admission.ownerToken });
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

export class HostedRateLimiter extends DurableObject<CaptunEnv> {
  private bucket: HostedRateLimitBucket | undefined;

  check(input: HostedRateLimitInput): HostedRateLimitResult {
    const now = Date.now();
    const bucket = this.activeBucket(now, now + input.windowSeconds * 1000);
    if (bucket.count >= input.limit) {
      return {
        ok: false,
        limit: input.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count++;
    return { ok: true };
  }

  private activeBucket(now: number, resetAt: number) {
    if (this.bucket && this.bucket.resetAt > now) return this.bucket;
    const bucket = { count: 0, resetAt };
    this.bucket = bucket;
    return bucket;
  }
}

export default {
  async fetch(request: Request, env: CaptunEnv): Promise<Response> {
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
      const rateLimited = await hostedRateLimitResponse({
        env,
        request,
        tunnelName,
        kind: "connect",
      });
      if (rateLimited) return rateLimited;

      const headers = new Headers(forwarded.headers);
      headers.set(TUNNEL_NAME_HEADER, tunnelName);
      return shard.fetch(new Request(forwarded, { headers }));
    }

    const rateLimited = await hostedRateLimitResponse({
      env,
      request,
      tunnelName,
      kind: "request",
    });
    if (rateLimited) return rateLimited;

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

async function hostedRateLimitResponse(input: {
  env: CaptunEnv;
  request: Request;
  tunnelName: string;
  kind: HostedRateLimitKind;
}): Promise<Response | undefined> {
  if (input.env.CUSTOM_HOSTNAME !== HOSTED_CAPTUN_HOSTNAME) return undefined;
  if (!input.env.HostedRateLimiter) {
    if (input.env.HOSTED_RATE_LIMIT_DISABLED === "1") return undefined;
    return new Response("Hosted rate limiter is not configured\n", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const config = hostedRateLimitConfig(input.env);
  const checks = hostedRateLimitChecks({
    kind: input.kind,
    clientKey: hostedClientKey(input.request),
    tunnelName: input.tunnelName,
    config,
  });
  for (const check of checks) {
    const limiter = input.env.HostedRateLimiter.getByName(hostedRateLimiterName(check.key));
    const result = await limiter.check({
      limit: check.limit,
      windowSeconds: config.windowSeconds,
    });
    if (!result.ok) return hostedRateLimitedResponse(result);
  }

  return undefined;
}

function hostedRateLimitedResponse(result: Extract<HostedRateLimitResult, { ok: false }>) {
  return new Response(`Rate limit exceeded. Try again in ${result.retryAfterSeconds}s.\n`, {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(result.retryAfterSeconds),
      "x-captun-rate-limit": String(result.limit),
    },
  });
}

function hostedClientKey(request: Request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function hostedRateLimitChecks(input: {
  kind: HostedRateLimitKind;
  clientKey: string;
  tunnelName: string;
  config: ReturnType<typeof hostedRateLimitConfig>;
}) {
  if (input.kind === "connect") {
    return [{ key: `connect:ip:${input.clientKey}`, limit: input.config.connectsPerIp }];
  }

  return [
    { key: `request:ip:${input.clientKey}`, limit: input.config.requestsPerIp },
    { key: `request:tunnel:${input.tunnelName}`, limit: input.config.requestsPerTunnel },
  ];
}

function hostedRateLimiterName(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `bucket-${(hash >>> 0).toString(36)}`;
}

function hostedRateLimitConfig(env: CaptunEnv) {
  return {
    windowSeconds: positiveInteger(
      env.HOSTED_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_HOSTED_RATE_LIMIT_WINDOW_SECONDS,
    ),
    connectsPerIp: positiveInteger(
      env.HOSTED_CONNECTS_PER_IP_PER_WINDOW,
      DEFAULT_HOSTED_CONNECTS_PER_IP_PER_WINDOW,
    ),
    requestsPerIp: positiveInteger(
      env.HOSTED_REQUESTS_PER_IP_PER_WINDOW,
      DEFAULT_HOSTED_REQUESTS_PER_IP_PER_WINDOW,
    ),
    requestsPerTunnel: positiveInteger(
      env.HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW,
      DEFAULT_HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW,
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

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
    return wwwCaptunResponse(url);
  }
  if (RESERVED_HOSTED_SUBDOMAINS.includes(subdomain)) {
    return new Response("Reserved captun.sh subdomain\n", { status: 404 });
  }
}

function wwwCaptunResponse(url: URL): Response {
  if (url.pathname === "/captun.browser.js") {
    return new Response(WWW_BROWSER_MODULE, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new Response(WWW_LANDING_PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const WWW_LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>captun</title>
  <style>
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    body { max-width: 840px; margin: 56px auto; padding: 0 20px 48px; font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111; background: #fff; }
    h1 { font-size: 28px; margin: 0 0 24px; }
    h2 { font-size: 16px; margin: 28px 0 8px; }
    pre, #from-code-source, #demo-source { padding: 12px 14px; overflow-x: auto; background: #f4f4f4; border: 1px solid #ddd; border-radius: 0; }
    #from-code-source, #demo-source { width: 100%; resize: vertical; font: 16px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: inherit; display: block; }
    #from-code-source { min-height: 210px; }
    #demo-source { min-height: 300px; }
    #from-code-source.enhanced, #demo-source.enhanced { display: none; }
    #from-code-editor, #demo-editor { display: none; border: 1px solid #ddd; background: #f4f4f4; }
    #from-code-editor.enhanced, #demo-editor.enhanced { display: block; }
    #from-code-editor .cm-editor, #demo-editor .cm-editor { background: #f4f4f4; font: 16px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    #from-code-editor .cm-scroller { min-height: 210px; }
    #demo-editor .cm-scroller { min-height: 300px; }
    button { margin: 12px 0; padding: 9px 12px; font: inherit; color: #fff; background: #111; border: 1px solid #111; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: wait; }
    .status-group { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .icon-button { width: 36px; height: 36px; margin: 0; padding: 0; align-items: center; justify-content: center; background: #fff; color: #111; line-height: 1; }
    iframe { width: 100%; height: 180px; border: 1px solid #ddd; background: #fff; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .muted { color: #555; }
    .error { color: #a40000; white-space: pre-wrap; }
    .hidden { display: none; }
    a { color: #0645ad; }
  </style>
</head>
<body>
  <h1>captun</h1>
  <p>cap[<a href="https://github.com/cloudflare/capnweb">nweb</a>] tun[nel]: a tiny, <a href="https://github.com/iterate/captun#performance">fast</a> public tunnel for local HTTP servers.</p>
  <p>Run this with something listening on port 3000:</p>
  <pre>npx captun 3000</pre>
  <p>You get a URL like:</p>
  <pre>https://abc123.captun.sh</pre>
  <p>Requests to that URL are forwarded to your local server until you stop the process.</p>

  <h2>From code</h2>
  <p>You don't need to run a local server. Just a fetch function:</p>
  <textarea id="from-code-source" spellcheck="false" readonly>import { createCaptunTunnel } from "captun";

const tunnel = await createCaptunTunnel({
  fetch: (request) => {
    const url = new URL(request.url);
    return Response.json({ method: request.method, path: url.pathname });
  },
});

console.log(tunnel.url);</textarea>
  <div id="from-code-editor"></div>

  <h2>Try it in this tab</h2>
  <p>This works in <em>any</em> environment supported by <a href="https://github.com/cloudflare/capnweb">capnweb</a>, so you can run a "server" basically anywhere, even the browser.</p>
  <p>Edit the fetch function, create a tunnel, then the iframe below will load the public URL.</p>
  <textarea id="demo-source" spellcheck="false">createCaptunTunnel({
  fetch: async (request) => {
    // your "server" is this browser tab!
    window.chatMessages ||= [];
    if (request.method === "POST") {
      window.chatMessages.push(await request.text());
      return Response.json({ ok: true });
    }
    const messages = window.chatMessages.join("\\n");
    return new Response(\`
      <script>
        let username = document.cookie.match(/username=([^;]+)/)?.[1];
        username ||= "user" + Math.random().toString().slice(2, 8);
        document.cookie = \\\`username=\\\${username}; Path=/; Secure\\\`;
        function send(form) {
          fetch("/", { method: "POST", body: username + ": " + form.m.value }).then(() => location.reload());
        }
      </script>
      <pre>\${messages}</pre>
      <form onsubmit="send(this); return false">
        <input name="m" style="font-size:16px" autofocus><button>send</button>
      </form>
    \`, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
})</textarea>
  <div id="demo-editor"></div>
  <div class="row">
    <button id="demo-create" type="button">create tunnel</button>
    <span class="status-group">
      <span id="demo-status" class="muted">idle</span>
      <button id="demo-reload" class="icon-button" type="button" aria-label="reload iframe" title="reload iframe" disabled>&#8635;</button>
    </span>
  </div>
  <p id="demo-url" class="hidden"><a id="demo-link" target="_blank" rel="noreferrer"></a></p>
  <p id="demo-error" class="error"></p>
  <iframe id="demo-frame" title="captun demo response"></iframe>

  <h2>Bring your own Cloudflare account</h2>
  <pre>npx captun deploy</pre>
  <p>Source: <a href="https://github.com/iterate/captun">github.com/iterate/captun</a></p>

  <script type="module">
    const fromCodeSource = document.querySelector("#from-code-source");
    const fromCodeEditorHost = document.querySelector("#from-code-editor");
    const source = document.querySelector("#demo-source");
    const editorHost = document.querySelector("#demo-editor");
    const button = document.querySelector("#demo-create");
    const reload = document.querySelector("#demo-reload");
    const status = document.querySelector("#demo-status");
    const urlRow = document.querySelector("#demo-url");
    const link = document.querySelector("#demo-link");
    const frame = document.querySelector("#demo-frame");
    const error = document.querySelector("#demo-error");
    let tunnel;
    let activeFetch;
    let editor;
    void enhanceEditor();
    const captunBrowser = import("/captun.browser.js");

    function currentSource() {
      return editor ? editor.state.doc.toString() : source.value;
    }

    function evaluateDemo() {
      let capturedFetch;
      const createCaptunTunnel = (options) => {
        capturedFetch = options.fetch;
        return { url: tunnel ? tunnel.url : "https://pending.captun.sh" };
      };
      new Function("createCaptunTunnel", currentSource())(createCaptunTunnel);
      if (typeof capturedFetch !== "function") throw new Error("Call createCaptunTunnel({ fetch }) in the editor.");
      activeFetch = capturedFetch;
    }

    function refreshTunnelFromSource() {
      if (!tunnel) return;
      try {
        evaluateDemo();
        status.textContent = "updated";
        error.textContent = "";
        frame.src = tunnel.url + "/";
      } catch (caught) {
        status.textContent = "edit has an error";
        error.textContent = caught && caught.stack ? caught.stack : String(caught);
      }
    }

    source.addEventListener("input", refreshTunnelFromSource);
    reload.addEventListener("click", () => {
      if (tunnel) frame.src = tunnel.url + "/";
    });

    button.addEventListener("click", async () => {
      button.disabled = true;
      reload.disabled = true;
      status.textContent = "connecting";
      error.textContent = "";

      try {
        if (tunnel) tunnel.close();
        evaluateDemo();
        const { createCaptunTunnel } = await captunBrowser;
        tunnel = await createCaptunTunnel({ fetch: (request) => activeFetch(request) });
        link.href = tunnel.url;
        link.textContent = tunnel.url;
        urlRow.classList.remove("hidden");
        frame.src = tunnel.url + "/";
        status.textContent = "connected";
        reload.disabled = false;
      } catch (caught) {
        status.textContent = "failed";
        error.textContent = caught && caught.stack ? caught.stack : String(caught);
      } finally {
        button.disabled = false;
      }
    });

    async function enhanceEditor() {
      try {
        const [{ EditorView, basicSetup }, { javascript }] = await Promise.all([
          import("https://esm.sh/codemirror@6.0.1"),
          import("https://esm.sh/@codemirror/lang-javascript@6.2.4"),
        ]);
        new EditorView({
          doc: fromCodeSource.value,
          extensions: [basicSetup, javascript(), EditorView.editable.of(false)],
          parent: fromCodeEditorHost,
        });
        editor = new EditorView({
          doc: source.value,
          extensions: [basicSetup, javascript(), EditorView.updateListener.of(refreshTunnelFromSource)],
          parent: editorHost,
        });
        fromCodeSource.classList.add("enhanced");
        fromCodeEditorHost.classList.add("enhanced");
        source.classList.add("enhanced");
        editorHost.classList.add("enhanced");
      } catch (caught) {
        console.warn("CodeMirror failed to load; using textarea editor.", caught);
      }
    }
  </script>
</body>
</html>`;

const WWW_BROWSER_MODULE = `import { newWebSocketRpcSession, RpcTarget } from "https://esm.sh/capnweb@0.8.0";

export async function createCaptunTunnel(options) {
  const tunnelName = options.name || randomTunnelName();
  const ownerToken = options.ownerToken || randomOwnershipToken();
  const publicUrl = "https://" + tunnelName + ".captun.sh";
  const socket = new WebSocket("wss://" + tunnelName + ".captun.sh/__captun-connect?captun-owner-token=" + ownerToken);
  const tunnelTargetFetcher = new TunnelTargetFetcher(options.fetch);
  const session = newWebSocketRpcSession(socket, tunnelTargetFetcher);
  await waitUntilOpen(socket);
  return {
    url: publicUrl,
    ownerToken,
    close: () => disposeSession(session),
  };
}

class TunnelTargetFetcher extends RpcTarget {
  constructor(fetcher) {
    super();
    this.fetcher = fetcher;
  }

  fetch(request) {
    return this.fetcher(request);
  }
}

function waitUntilOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(new Error("WebSocket closed before opening"));
  }

  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const settle = (callback) => {
      listeners.abort();
      callback();
    };
    socket.addEventListener("open", () => settle(resolve), { signal: listeners.signal });
    socket.addEventListener("error", () => settle(() => reject(new Error("WebSocket connection failed"))), { signal: listeners.signal });
    socket.addEventListener("close", (event) => settle(() => reject(new Error("WebSocket closed before opening: " + event.code + " " + event.reason))), { signal: listeners.signal });
  });
}

function randomTunnelName() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomOwnershipToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function disposeSession(session) {
  const disposeSymbol = Symbol.dispose;
  if (disposeSymbol && typeof session[disposeSymbol] === "function") session[disposeSymbol]();
}
`;
