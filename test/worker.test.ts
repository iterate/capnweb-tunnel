import { expect, test } from "vitest";
import { createCaptunTunnel } from "../src/index.js";
import { captunHealthResponse, isCaptunHealthRequest } from "../src/cli/tunnel-health.js";
import { captunShardName, getTunnelNameFromUrl } from "../src/routing.js";
import { createCaptunWorkerFixture } from "./miniflare.js";

const tunnelNameCases: Array<
  [url: string, customHostname: string | undefined, name: string | null]
> = [
  // Folder routing (no customHostname): first path segment is the tunnel name.
  ["https://captun.account.workers.dev/my-test/hello", undefined, "my-test"],
  ["https://captun.account.workers.dev/my-test/__captun-connect", undefined, "my-test"],
  ["https://captun.account.workers.dev/__captun-connect", undefined, null],
  ["https://captun.account.workers.dev/", undefined, null],
  ["http://localhost:8787/my-test/hello", undefined, "my-test"],
  ["https://captun.account.workers.dev/bad%/hello", undefined, null],

  // Subdomain routing: tunnel name is the last label before customHostname.
  ["https://my-test.captun.example.com/hello", "captun.example.com", "my-test"],
  ["https://my-test.my-tunnels.com/hello", "my-tunnels.com", "my-test"],
  ["https://my-test.my-tunnels.com/__captun-connect", "my-tunnels.com", "my-test"],
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
    url: `${fixture.origin}/demo/__captun-connect`,
    fetch: async (request) => {
      const url = new URL(request.url);
      return Response.json({
        path: url.pathname,
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
    body: "You said: hello through miniflare",
  });
});

test("Captun Worker verifies health through a connected tunnel client", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _tunnel = await createCaptunTunnel({
    url: `${fixture.origin}/demo/__captun-connect`,
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
    url: `${fixture.origin}/demo/__captun-connect`,
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

test("Captun Worker rejects missing tunnel names before Durable Object dispatch", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/__captun-connect`);

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker rejects malformed folder tunnel names", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/bad%/hello`);

  expect(response).toMatchObject({ status: 404 });
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker requires the configured secret before accepting a tunnel client", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_SECRET: "secret" });

  const response = await fetch(`${fixture.origin}/demo/__captun-connect`);

  expect(response).toMatchObject({ status: 401 });
  expect(await response.text()).toBe("Unauthorized\n");
});
