import { expect, test } from "vitest";
import { createCaptunTunnel } from "../src/index.js";
import { captunHealthResponse, isCaptunHealthRequest } from "../src/cli/tunnel-health.js";
import {
  captunShardName,
  getTunnelNameFromUrl,
  getTunnelUrl,
  TUNNEL_URL_HEADER,
} from "../src/routing.js";
import { createCaptunWorkerFixture } from "./miniflare.js";

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
