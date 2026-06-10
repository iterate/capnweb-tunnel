import { createServer } from "node:http";

import { expect, test } from "vitest";
import { connectTokenFromRequest, createCaptunTunnel } from "../src/index.js";
import { captunHealthResponse, isCaptunHealthRequest } from "../src/cli/tunnel-health.js";
import {
  captunShardName,
  getTunnelNameFromUrl,
  getTunnelUrl,
  TUNNEL_URL_HEADER,
} from "../src/server/tunnel-addressing.js";
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

test("createCaptunTunnel only returns a gateway-confirmed token", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  using tunnel = await createCaptunTunnel({
    gateway: fixture.origin,
    name: "demo",
    token: "client-generated-token",
    fetch: () => new Response("pong\n"),
  });

  expect(tunnel).toMatchObject({
    url: `${fixture.origin}/demo`,
    token: undefined,
  });
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

test("Captun Worker ignores hosted rate-limit bindings in self-hosted folder routing", async () => {
  await using fixture = await createCaptunWorkerFixture({
    HOSTED_REQUESTS_PER_IP_PER_WINDOW: "1",
  });
  const headers = { "cf-connecting-ip": "203.0.113.40" };

  const first = await fixture.worker.fetch(`${fixture.origin}/one/hello`, { headers });
  const second = await fixture.worker.fetch(`${fixture.origin}/two/hello`, { headers });

  expect(first).toMatchObject({ status: 503 });
  expect(second).toMatchObject({ status: 503 });
});

test("Captun Worker does not apply hosted reserved names to self-hosted folder routing", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fixture.worker.fetch(`${fixture.origin}/billing/hello`);

  expect(response).toMatchObject({ status: 503 });
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test.each(["captun", "gateway"])(
  "Captun Worker reserves %s for self-hosted custom-domain routing",
  async (tunnelName) => {
    await using fixture = await createCaptunWorkerFixture({
      CUSTOM_HOSTNAME: "example.com",
    });

    const response = await fixture.worker.fetch(`https://${tunnelName}.example.com/hello`);

    expect(response).toMatchObject({ status: 404 });
    expect(await response.text()).toBe("Reserved Captun tunnel name\n");
  },
);

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

test("Captun Worker admits a token sent via Sec-WebSocket-Protocol", async () => {
  // Non-URL-safe characters prove the base64url subprotocol encoding: this
  // token could not have survived as a raw query param or subprotocol value.
  const token = "s3cret token+with/odd=chars";
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_TOKEN: token });

  using tunnel = await createCaptunTunnel({
    gateway: fixture.origin,
    name: "subprotocol-token-demo",
    token,
    fetch: () => Response.json({ ok: true }),
  });

  const response = await fetch(`${tunnel.url}/hello`);
  expect(await response.json()).toEqual({ ok: true });
});

test("createCaptunTunnel diagnoses a wrong token as 401", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "right-token" });

  await expect(
    createCaptunTunnel({
      gateway: fixture.origin,
      name: "wrong-token-demo",
      token: "wrong-token",
      fetch: () => new Response("unused\n"),
    }),
  ).rejects.toThrow(/401 Unauthorized/);
});

test("Captun Worker still admits legacy clients that send the token as a query param", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "legacy-token" });

  const response = await fixture.worker.fetch(
    `${fixture.origin}/?captun-connect=1&captun-name=legacy&captun-token=legacy-token`,
    { headers: { upgrade: "websocket" } },
  );

  expect(response).toMatchObject({ status: 101 });
});

test("Captun Worker echoes the captun subprotocol on the 101 response", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fixture.worker.fetch(
    `${fixture.origin}/?captun-connect=1&captun-name=echo-demo`,
    {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `captun, captun-token.${Buffer.from("tok").toString("base64url")}`,
      },
    },
  );

  expect(response).toMatchObject({ status: 101 });
  expect(response.headers.get("sec-websocket-protocol")).toBe("captun");
});

test("createCaptunTunnel keeps the Connect Token out of the URL", async () => {
  await using gateway = await createUpgradeCapturingServer();

  await createCaptunTunnel({
    gateway: gateway.origin,
    name: "demo",
    token: "super secret token",
    fetch: () => new Response("unused\n"),
  }).catch(() => undefined); // the capturing server rejects every upgrade

  expect(gateway.upgrades).toHaveLength(1);
  expect(gateway.upgrades[0]!.url).not.toContain("captun-token");
  expect(gateway.upgrades[0]!.subprotocols).toContain("captun");
  expect(gateway.upgrades[0]!.subprotocols).toContain(
    `captun-token.${Buffer.from("super secret token").toString("base64url")}`,
  );
});

test("connectTokenFromRequest prefers subprotocol, then header, then query param", () => {
  const url = "https://gateway.example/?captun-token=from-query";
  const subprotocols = `captun, captun-token.${Buffer.from("from subprotocol ✨").toString("base64url")}`;

  expect(connectTokenFromRequest(new Request(url))).toBe("from-query");
  expect(
    connectTokenFromRequest(
      new Request(url, { headers: { "x-captun-connect-token": "from-header" } }),
    ),
  ).toBe("from-header");
  expect(
    connectTokenFromRequest(
      new Request(url, {
        headers: {
          "x-captun-connect-token": "from-header",
          "sec-websocket-protocol": subprotocols,
        },
      }),
    ),
  ).toBe("from subprotocol ✨");
  // Malformed base64url falls through to the next transport.
  expect(
    connectTokenFromRequest(
      new Request(url, { headers: { "sec-websocket-protocol": "captun, captun-token.%%%" } }),
    ),
  ).toBe("from-query");
});

test("Captun Worker rejects the legacy CAPTUN_SECRET binding", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_SECRET: "legacy-secret" });

  await expect(fixture.worker.fetch(`${fixture.origin}/missing/hello`)).rejects.toThrow(
    "CAPTUN_SECRET has been renamed to CAPTUN_TOKEN",
  );
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

async function createUpgradeCapturingServer() {
  const upgrades: Array<{ url: string; subprotocols: string[] }> = [];
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    upgrades.push({
      url: request.url || "",
      subprotocols: (request.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((protocol) => protocol.trim()),
    });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start test server");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    upgrades,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

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
