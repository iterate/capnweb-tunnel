import { createServer } from "node:http";

import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { createCaptunTunnel } from "../src/index.js";
import { captunHealthResponse, isCaptunHealthRequest } from "../src/cli/tunnel-health.js";
import {
  captunShardName,
  getTunnelNameFromUrl,
  getTunnelUrl,
  TUNNEL_CONNECT_DIAGNOSTIC_HEADER,
  TUNNEL_URL_HEADER,
} from "../src/routing.js";
import { createCaptunWorkerFixture, createMiniflareWorkerFixture } from "./miniflare.js";

const tunnelNameCases: Array<
  [url: string, customHostname: string | undefined, name: string | null]
> = [
  // Folder routing (no customHostname): first path segment is the tunnel name.
  ["https://captun.account.workers.dev/my-test/hello", undefined, "my-test"],
  ["https://captun.account.workers.dev/my-test/nested/path", undefined, "my-test"],
  ["https://captun.account.workers.dev/", undefined, null],
  ["http://localhost:8787/my-test/hello", undefined, "my-test"],
  ["https://captun.account.workers.dev/bad%/hello", undefined, null],

  // Subdomain routing: tunnel name is the last label before customHostname.
  ["https://my-test.captun.example.com/hello", "captun.example.com", "my-test"],
  ["https://my-test.my-tunnels.com/hello", "my-tunnels.com", "my-test"],
  ["https://my-test.my-tunnels.com/nested/path", "my-tunnels.com", "my-test"],
  ["https://my-test.mysubdomain.mydomain.com/hello", "mysubdomain.mydomain.com", "my-test"],

  // Nested wildcard: the *last* label before customHostname wins. Anything to
  // the left is ignored, so a deeper wildcard cert lets every subdomain land
  // in one tunnel.
  ["https://some-subdomain.banana.tunnels.mydomain.com/hello", "tunnels.mydomain.com", "banana"],
  [
    "https://some-subdomain.banana.tunnels.mydomain.com/hello",
    "banana.tunnels.mydomain.com",
    "some-subdomain",
  ],
  ["https://a.b.c.banana.tunnels.mydomain.com/hello", "tunnels.mydomain.com", "banana"],

  // Hostname must be a subdomain of customHostname.
  ["https://tunnels.mydomain.com/anything", "tunnels.mydomain.com", null],
  ["https://other-zone.com/anything", "tunnels.mydomain.com", null],
  // Substring-but-not-subdomain (no leading dot before customHostname) doesn't match.
  ["https://eviltunnels.mydomain.com/anything", "tunnels.mydomain.com", null],
];

test.each(tunnelNameCases)(
  "getTunnelNameFromUrl(%s, customHostname=%s) -> %s",
  (url, customHostname, name) => {
    expect(getTunnelNameFromUrl({ url, customHostname })).toBe(name);
  },
);

const tunnelUrlCases: Array<
  [reqUrl: string, customHostname: string | undefined, tunnelName: string, expected: string]
> = [
  // Folder mode: protocol + host from reqUrl, name appended as a path segment.
  [
    "https://captun.acct.workers.dev/banana/nested/path",
    undefined,
    "banana",
    "https://captun.acct.workers.dev/banana",
  ],
  ["http://localhost:8787/x/y", undefined, "my-test", "http://localhost:8787/my-test"],
  ["http://localhost:8787/x/y", undefined, "my test", "http://localhost:8787/my%20test"],
  // Subdomain mode: customHostname dictates the host; reqUrl only supplies the protocol.
  [
    "https://banana.tunnels.mydomain.com/x",
    "tunnels.mydomain.com",
    "banana",
    "https://banana.tunnels.mydomain.com",
  ],
  // Nested wildcard: canonical pick is always `<name>.<customHostname>`, dropping any deeper labels.
  [
    "https://some.banana.tunnels.mydomain.com/x",
    "tunnels.mydomain.com",
    "banana",
    "https://banana.tunnels.mydomain.com",
  ],
  [
    "https://some.banana.tunnels.mydomain.com/x",
    "banana.tunnels.mydomain.com",
    "some",
    "https://some.banana.tunnels.mydomain.com",
  ],
];

test.each(tunnelUrlCases)(
  "getTunnelUrl(reqUrl=%s, customHostname=%s, tunnelName=%s) -> %s",
  (reqUrl, customHostname, tunnelName, expected) => {
    expect(getTunnelUrl({ reqUrl, customHostname, tunnelName })).toBe(expected);
  },
);

test("getTunnelUrl and getTunnelNameFromUrl round-trip", () => {
  for (const [, customHostname, tunnelName] of tunnelUrlCases) {
    const url = getTunnelUrl({
      reqUrl: "https://placeholder.example.com/",
      customHostname,
      tunnelName,
    });
    expect(getTunnelNameFromUrl({ url: `${url}/some/path`, customHostname })).toBe(tunnelName);
  }
});

test("Captun Worker uses one warm shard by default", () => {
  expect(captunShardName("alpha", 1)).toBe("tunnel-shard-0");
  expect(captunShardName("beta", 0)).toBe("tunnel-shard-0");
});

test("Captun Worker keeps a tunnel name on a stable shard", () => {
  expect(captunShardName("my-test", 16)).toBe(captunShardName("my-test", 16));
  expect(captunShardName("my-test", 16)).toMatch(/^tunnel-shard-(?:[0-9]|1[0-5])$/);
});

test("Captun Worker forwards requests through a real Durable Object tunnel", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _tunnel = await createCaptunTunnel({
    gateway: fixture.origin,
    name: "demo",
    fetch: async (request) => {
      const url = new URL(request.url);
      return Response.json({
        path: url.pathname,
        tunnelUrl: request.headers.get(TUNNEL_URL_HEADER),
        body: `You said: ${await request.text()}`,
      });
    },
  });

  const response = await fetch(`${fixture.origin}/demo/hello`, {
    method: "POST",
    body: "hello through miniflare",
  });

  expect(await response.json()).toMatchObject({
    path: "/hello",
    tunnelUrl: `${fixture.origin}/demo`,
    body: "You said: hello through miniflare",
  });
});

test("Captun Worker verifies health through a connected tunnel client", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _tunnel = await createCaptunTunnel({
    gateway: fixture.origin,
    name: "demo",
    fetch: (request) => {
      if (isCaptunHealthRequest(request)) return captunHealthResponse();
      return new Response("unexpected\n", { status: 500 });
    },
  });

  const response = await fetch(`${fixture.origin}/demo/__captun/health`);

  expect(response).toMatchObject({ status: 200 });
  expect(await response.json()).toEqual({ ok: true });
});

test("Captun Worker returns 502 when the tunnel client fetch throws", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _tunnel = await createCaptunTunnel({
    gateway: fixture.origin,
    name: "demo",
    fetch: () => {
      throw new Error("local target unavailable");
    },
  });

  const response = await fetch(`${fixture.origin}/demo/hello`);

  expect(response).toMatchObject({ status: 502 });
  expect(await response.text()).toBe("Tunnel fetch failed\n");
});

test("Captun Worker returns 503 when a named tunnel has no connected client", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/missing/hello`);

  expect(response).toMatchObject({ status: 503 });
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test("Captun Worker routes subdomain tunnel requests when CUSTOM_HOSTNAME is set", async () => {
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.example.com" });

  const response = await fixture.worker.fetch("http://demo.captun.example.com/hello");

  expect(response).toMatchObject({ status: 503 });
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test("Hosted Captun redirects the apex hostname to www", async () => {
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.sh" });

  const response = await fixture.worker.fetch("https://captun.sh/docs?x=1", {
    redirect: "manual",
  });

  expect(response).toMatchObject({ status: 308 });
  expect(response.headers.get("location")).toBe("https://www.captun.sh/docs?x=1");
});

test("Hosted Captun serves a static landing page on www", async () => {
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.sh" });

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
});

test("Hosted Captun serves the browser demo module on www", async () => {
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.sh" });

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
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.sh" });

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
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.sh" });

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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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

test("Hosted Captun rate limits do not affect self-hosted folder routing", async () => {
  await using fixture = await createCaptunWorkerFixture({
    HOSTED_REQUESTS_PER_IP_PER_WINDOW: "1",
  });
  const headers = { "cf-connecting-ip": "203.0.113.40" };

  const first = await fixture.worker.fetch(`${fixture.origin}/one/hello`, { headers });
  const second = await fixture.worker.fetch(`${fixture.origin}/two/hello`, { headers });

  expect(first).toMatchObject({ status: 503 });
  expect(second).toMatchObject({ status: 503 });
});

test("Hosted Captun fails closed when the rate limiter binding is missing", async () => {
  await using fixture = await createMiniflareWorkerFixture({
    entryPoint: "src/worker.ts",
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
    entryPoint: "src/worker.ts",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
    entryPoint: "src/worker.ts",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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
  await using fixture = await createCaptunWorkerFixture({
    CUSTOM_HOSTNAME: "captun.sh",
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

test("createCaptunTunnel surfaces rejected WebSocket upgrade response details", async () => {
  await using rejection = await createRejectedWebSocketUpgradeServer({
    status: 409,
    body: "Tunnel name is already connected\n",
  });

  await expect(
    createCaptunTunnel({
      gateway: rejection.origin,
      name: "demo",
      fetch: () => new Response("unused\n"),
    }),
  ).rejects.toThrow(/409 Conflict: Tunnel name is already connected/);
});

test("createCaptunTunnel falls back when the rejected upgrade probe does not respond", async () => {
  await using rejection = await createRejectedWebSocketUpgradeServer({
    status: 409,
    body: "Tunnel name is already connected\n",
    neverRespondToHttp: true,
  });

  let caught: unknown;
  try {
    await createCaptunTunnel({
      gateway: rejection.origin,
      name: "demo",
      fetch: () => new Response("unused\n"),
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({ message: "WebSocket connection failed" });
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
  await using fixture = await createCaptunWorkerFixture({ CUSTOM_HOSTNAME: "captun.sh" });

  const response = await fixture.worker.fetch(`https://${subdomain}.captun.sh/`);

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Reserved Captun tunnel name\n");
});

test("Captun Worker rejects missing tunnel names before Durable Object dispatch", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fixture.worker.fetch(`${fixture.origin}/?captun-connect=1`, {
    headers: { upgrade: "websocket" },
  });

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker rejects malformed folder tunnel names", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/bad%/hello`);

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker requires the configured token before accepting a tunnel client", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "token" });

  const response = await fixture.worker.fetch(
    `${fixture.origin}/?captun-connect=1&captun-name=demo`,
    { headers: { upgrade: "websocket" } },
  );

  expect(response).toMatchObject({ status: 401 });
  expect(await response.text()).toBe("Unauthorized\n");
});

test("Captun Worker rejects the legacy CAPTUN_SECRET binding", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_SECRET: "legacy-secret" });

  await expect(fixture.worker.fetch(`${fixture.origin}/missing/hello`)).rejects.toThrow(
    "CAPTUN_SECRET has been renamed to CAPTUN_TOKEN",
  );
});

async function createRejectedWebSocketUpgradeServer(options: {
  status: number;
  body: string;
  neverRespondToHttp?: boolean;
}) {
  const sockets = new Set<{ destroy: () => void }>();
  const statusText = options.status === 409 ? "Conflict" : "Rejected";
  const server = createServer((_request, response) => {
    if (options.neverRespondToHttp) return;
    response.writeHead(options.status, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(options.body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => {
    socket.write(
      [
        `HTTP/1.1 ${options.status} ${statusText}`,
        "Content-Type: text/plain; charset=utf-8",
        "Cache-Control: no-store",
        `Content-Length: ${Buffer.byteLength(options.body)}`,
        "Connection: close",
        "",
        options.body,
      ].join("\r\n"),
    );
    socket.destroy();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start test server");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

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
