import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { TUNNEL_CONNECT_DIAGNOSTIC_HEADER } from "../src/routing.js";
import { createHostedCaptunWorkerFixture, createMiniflareWorkerFixture } from "./miniflare.js";

test("Hosted Captun redirects the apex hostname to www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://captun.sh/docs?x=1", {
    redirect: "manual",
  });

  expect(response).toMatchObject({ status: 308 });
  expect(response.headers.get("location")).toBe("https://www.captun.sh/docs?x=1");
});

test("Hosted Captun serves a static landing page on www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/");

  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();

  expect(html).toEqual(
    expect.stringContaining(
      'cap[<a href="https://github.com/cloudflare/capnweb">nweb</a>] tun[nel]',
    ),
  );
  expect(html).toEqual(
    expect.stringContaining('<a href="https://github.com/iterate/captun#performance">fast</a>'),
  );
  expect(html).toEqual(expect.stringContaining("Run this with something listening on port 3000:"));
  expect(html).toEqual(expect.stringContaining("npx captun 3000"));
  expect(html).toEqual(
    expect.stringContaining("You don't need to run a local server. Just a fetch function:"),
  );
  expect(html).toEqual(
    expect.stringContaining('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'),
  );
});

test("Hosted Captun serves a tunnel favicon on www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/favicon.svg");

  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("image/svg+xml");
  expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  const svg = await response.text();
  expect(svg).toEqual(expect.stringContaining("<svg"));
  expect(svg).toEqual(expect.stringContaining("<path"));
});

test("Hosted Captun serves the browser demo module on www", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/captun.browser.js");

  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("application/javascript");
  const module = await response.text();
  expect(module).toEqual(expect.stringContaining("createCaptunTunnel"));
  expect(module).toEqual(expect.stringContaining("captun-connect"));
  expect(module).toEqual(expect.stringContaining("captun-token"));
  expect(module).toEqual(expect.stringContaining("randomConnectToken"));
  expect(module).not.toEqual(expect.stringContaining("__captun-connect"));
});

test("Hosted Captun landing page includes an in-browser tunnel demo", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/");

  const html = await response.text();

  expect(html.indexOf("<h2>Try it in this tab</h2>")).toBeLessThan(
    html.indexOf("<h2>Bring your own Cloudflare account</h2>"),
  );
  expect(
    html.indexOf(
      'This works in <em>any</em> environment supported by <a href="https://github.com/cloudflare/capnweb">capnweb</a>',
    ),
  ).toBeLessThan(
    html.indexOf("Edit the fetch function, create a tunnel, then the iframe below will load"),
  );
  expect(html).toEqual(
    expect.stringContaining(
      'This works in <em>any</em> environment supported by <a href="https://github.com/cloudflare/capnweb">capnweb</a>',
    ),
  );
  expect(html).toEqual(expect.stringContaining('// your "server" is this browser tab!'));
  expect(html).toEqual(expect.stringContaining("window.chatMessages"));
  expect(html).toEqual(
    expect.stringContaining(
      "window.chatMessages.join(\"\\n\").replace(/&/g, '&amp').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#039;').replace(/`/g, '&#96;')",
    ),
  );
  expect(html).toEqual(expect.stringContaining("document.cookie"));
  expect(html).toEqual(expect.stringContaining("username ||= "));
  expect(html).toEqual(expect.stringContaining("function send(form)"));
  expect(html).toEqual(expect.stringContaining('onsubmit="send(this); return false"'));
  expect(html).toEqual(expect.stringContaining("<button>send</button>"));
  expect(html).toEqual(expect.stringContaining("Response.json({ ok: true })"));
  expect(html).toEqual(expect.stringContaining('<textarea id="demo-source" spellcheck="false">'));
  expect(html).toEqual(
    expect.stringContaining(
      '<button id="demo-reload" class="icon-button" type="button" aria-label="reload iframe" title="reload iframe" disabled>&#8635;</button>',
    ),
  );
  expect(html).toEqual(expect.stringContaining("text-size-adjust: 100%"));
  expect(html).toEqual(expect.stringContaining('style="font-size:16px" autofocus'));
  expect(html).toEqual(expect.stringContaining("function currentSource()"));
  expect(html).toEqual(expect.stringContaining('frame.src = tunnel.url + "/"'));
  expect(html).toEqual(expect.stringContaining("void enhanceEditor();"));
  expect(html).toEqual(
    expect.stringContaining('const captunBrowser = import("/captun.browser.js");'),
  );
  expect(html).not.toContain('import { createCaptunTunnel } from "/captun.browser.js";');
});

test("Hosted Captun landing page loads CodeMirror for the browser demo editor", async () => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch("https://www.captun.sh/");

  const html = await response.text();

  expect(html).toEqual(expect.stringContaining("codemirror@6.0.1"));
  expect(html).toEqual(expect.stringContaining('id="from-code-source"'));
  expect(html).toEqual(expect.stringContaining("EditorView.editable.of(false)"));
  expect(html).not.toContain("EditorView.lineWrapping");
  expect(html).toEqual(
    expect.stringContaining("CodeMirror failed to load; using textarea editor."),
  );
});

test("Hosted Captun rate limits tunnel connect attempts per client IP", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    CAPTUN_TOKEN: "secret",
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "1",
  });
  const headers = { upgrade: "websocket", "cf-connecting-ip": "203.0.113.10" };

  const first = await fixture.worker.fetch("https://captun.sh/?captun-connect=1&captun-name=one", {
    headers,
  });
  const second = await fixture.worker.fetch("https://captun.sh/?captun-connect=1&captun-name=two", {
    headers,
  });

  expect(first).toMatchObject({ status: 401 });
  expect(second).toMatchObject({ status: 429 });
  expect(second.headers.get("retry-after")).toBe("60");
  expect(second.headers.get("cache-control")).toBe("no-store");
  expect(await second.text()).toBe("Rate limit exceeded. Try again in 60s.\n");
});

test("Hosted Captun rate limits forwarded requests per client IP", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_REQUESTS_PER_IP_PER_WINDOW: "2",
    HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW: "100",
  });
  const headers = { "cf-connecting-ip": "203.0.113.20" };

  const first = await fixture.worker.fetch("https://one.captun.sh/hello", { headers });
  const second = await fixture.worker.fetch("https://two.captun.sh/hello", { headers });
  const third = await fixture.worker.fetch("https://three.captun.sh/hello", { headers });

  expect(first).toMatchObject({ status: 503 });
  expect(second).toMatchObject({ status: 503 });
  expect(third).toMatchObject({ status: 429 });
  expect(third.headers.get("x-captun-rate-limit")).toBe("2");
});

test("Hosted Captun rate limits forwarded requests per tunnel name", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_REQUESTS_PER_IP_PER_WINDOW: "100",
    HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW: "1",
  });

  const first = await fixture.worker.fetch("https://one.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.30" },
  });
  const second = await fixture.worker.fetch("https://one.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.31" },
  });
  const otherTunnel = await fixture.worker.fetch("https://two.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.31" },
  });

  expect(first).toMatchObject({ status: 503 });
  expect(second).toMatchObject({ status: 429 });
  expect(otherTunnel).toMatchObject({ status: 503 });
});

test("Hosted Captun fails closed when the rate limiter binding is missing", async () => {
  await using fixture = await createMiniflareWorkerFixture({
    entryPoint: "src/hosted/worker.ts",
    durableObjects: {
      CaptunServerShard: { className: "CaptunServerShard" },
    },
    bindings: { CUSTOM_HOSTNAME: "captun.sh" },
  });

  const response = await fixture.worker.fetch("https://one.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.50" },
  });

  expect(response).toMatchObject({ status: 503 });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("Hosted rate limiter is not configured\n");
});

test("Hosted Captun only bypasses a missing rate limiter binding when explicitly disabled", async () => {
  await using fixture = await createMiniflareWorkerFixture({
    entryPoint: "src/hosted/worker.ts",
    durableObjects: {
      CaptunServerShard: { className: "CaptunServerShard" },
    },
    bindings: {
      CUSTOM_HOSTNAME: "captun.sh",
      HOSTED_RATE_LIMIT_DISABLED: "1",
      HOSTED_REQUESTS_PER_IP_PER_WINDOW: "1",
    },
  });

  const first = await fixture.worker.fetch("https://one.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.51" },
  });
  const second = await fixture.worker.fetch("https://two.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.51" },
  });

  expect(first).toMatchObject({ status: 503 });
  expect(second).toMatchObject({ status: 503 });
});

test("Hosted Captun does not trust spoofable forwarded IP headers for rate limiting", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_REQUESTS_PER_IP_PER_WINDOW: "1",
  });

  const first = await fixture.worker.fetch("https://one.captun.sh/hello", {
    headers: { "x-forwarded-for": "203.0.113.60" },
  });
  const second = await fixture.worker.fetch("https://two.captun.sh/hello", {
    headers: { "x-forwarded-for": "203.0.113.61" },
  });

  expect(first).toMatchObject({ status: 503 });
  expect(second).toMatchObject({ status: 429 });
});

test("Hosted Captun rejects a different token while a tunnel is active", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "100",
  });
  using _tokenTunnel = await createDirectWorkerTunnel({
    fixture,
    url: "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    responseText: "token a\n",
    clientIp: "203.0.113.70",
  });

  const conflict = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-b",
    { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.71" } },
  );
  expect(conflict).toMatchObject({ status: 409 });
  expect(await conflict.text()).toBe("Tunnel name is already connected\n");

  const stillOwned = await fixture.worker.fetch("https://demo.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.72" },
  });

  expect(stillOwned).toMatchObject({ status: 200 });
  expect(await stillOwned.text()).toBe("token a\n");
});

test("Hosted Captun connect diagnostics do not replace active tunnels", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "100",
  });
  using _tokenTunnel = await createDirectWorkerTunnel({
    fixture,
    url: "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    responseText: "token a\n",
    clientIp: "203.0.113.74",
  });

  const diagnostic = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    {
      headers: {
        "cf-connecting-ip": "203.0.113.75",
        [TUNNEL_CONNECT_DIAGNOSTIC_HEADER]: "1",
      },
    },
  );
  const stillOwned = await fixture.worker.fetch("https://demo.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.76" },
  });

  expect(diagnostic).toMatchObject({ status: 204 });
  expect(stillOwned).toMatchObject({ status: 200 });
  expect(await stillOwned.text()).toBe("token a\n");
});

test("Hosted Captun connect diagnostics do not spend connect rate-limit slots", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "2",
  });
  using _tokenTunnel = await createDirectWorkerTunnel({
    fixture,
    url: "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    responseText: "token a\n",
    clientIp: "203.0.113.77",
  });

  const firstConflict = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-b",
    { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.78" } },
  );
  const diagnostic = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-b",
    {
      headers: {
        "cf-connecting-ip": "203.0.113.78",
        [TUNNEL_CONNECT_DIAGNOSTIC_HEADER]: "1",
      },
    },
  );
  const secondConflict = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-c",
    { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.78" } },
  );

  expect(firstConflict).toMatchObject({ status: 409 });
  expect(diagnostic).toMatchObject({ status: 409 });
  expect(await diagnostic.text()).toBe("Tunnel name is already connected\n");
  expect(secondConflict).toMatchObject({ status: 409 });
});

test("Hosted Captun connect diagnostics surface recent connect rate limits", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "1",
  });
  using _tokenTunnel = await createDirectWorkerTunnel({
    fixture,
    url: "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    responseText: "token a\n",
    clientIp: "203.0.113.79",
  });

  const rateLimited = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-b",
    { headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.79" } },
  );
  const diagnostic = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-b",
    {
      headers: {
        "cf-connecting-ip": "203.0.113.79",
        [TUNNEL_CONNECT_DIAGNOSTIC_HEADER]: "1",
      },
    },
  );

  expect(rateLimited).toMatchObject({ status: 429 });
  expect(diagnostic).toMatchObject({ status: 429 });
  expect(await diagnostic.text()).toMatch(/^Rate limit exceeded\. Try again in \d+s\.\n$/);
});

test("Hosted Captun connect diagnostics fail closed when rate limiter binding is missing", async () => {
  await using fixture = await createMiniflareWorkerFixture({
    entryPoint: "src/hosted/worker.ts",
    durableObjects: { CaptunServerShard: { className: "CaptunServerShard" } },
    bindings: { CUSTOM_HOSTNAME: "captun.sh" },
  });

  const diagnostic = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    {
      headers: {
        "cf-connecting-ip": "203.0.113.84",
        [TUNNEL_CONNECT_DIAGNOSTIC_HEADER]: "1",
      },
    },
  );

  expect(diagnostic).toMatchObject({ status: 503 });
  expect(await diagnostic.text()).toBe("Hosted rate limiter is not configured\n");
});

test("Hosted Captun lets the same token replace its active tunnel", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "100",
  });
  using _firstTunnel = await createDirectWorkerTunnel({
    fixture,
    url: "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    responseText: "first\n",
    clientIp: "203.0.113.80",
  });
  using _secondTunnel = await createDirectWorkerTunnel({
    fixture,
    url: "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    responseText: "second\n",
    clientIp: "203.0.113.81",
  });

  const response = await fixture.worker.fetch("https://demo.captun.sh/hello", {
    headers: { "cf-connecting-ip": "203.0.113.82" },
  });

  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toBe("second\n");
});

test("Hosted Captun requires anonymous tokens for public hosted connections", async () => {
  await using fixture = await createHostedCaptunWorkerFixture({
    HOSTED_CONNECTS_PER_IP_PER_WINDOW: "100",
  });

  const response = await fixture.worker.fetch(
    "https://captun.sh/?captun-connect=1&captun-name=demo",
    {
      headers: { upgrade: "websocket", "cf-connecting-ip": "203.0.113.90" },
    },
  );

  expect(response).toMatchObject({ status: 400 });
  expect(await response.text()).toBe("Missing tunnel token\n");
});

test.each([
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "captun",
  "dash",
  "dashboard",
  "docs",
  "gateway",
  "gateways",
  "iterate",
  "login",
  "payment",
  "payments",
  "status",
  "support",
  "tunnel",
  "tunnels",
])("Hosted Captun reserves %s.captun.sh", async (subdomain) => {
  await using fixture = await createHostedCaptunWorkerFixture();

  const response = await fixture.worker.fetch(`https://${subdomain}.captun.sh/`);

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Reserved Captun tunnel name\n");
});

async function createDirectWorkerTunnel(options: {
  fixture: any;
  url: string;
  responseText: string;
  clientIp: string;
}) {
  const response = await options.fixture.worker.fetch(options.url, {
    headers: {
      upgrade: "websocket",
      "cf-connecting-ip": options.clientIp,
    },
  });
  expect(response).toMatchObject({ status: 101 });

  const socket = response.webSocket;
  socket.accept();
  const session = newWebSocketRpcSession(socket, new TestTunnelFetcher(options.responseText));

  return {
    [Symbol.dispose]() {
      session[Symbol.dispose]();
    },
  };
}

class TestTunnelFetcher extends RpcTarget {
  private responseText: string;

  constructor(responseText: string) {
    super();
    this.responseText = responseText;
  }

  fetch() {
    return new Response(this.responseText);
  }

  ready() {}
}
