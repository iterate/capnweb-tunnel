import { expect, test } from "vitest";
import { createCaptunTunnel } from "../src/client.js";
import { captunRouteParts, captunShardName } from "../src/worker-routing.js";
import { createCaptunWorkerFixture } from "./miniflare.js";

const routeCases: Array<
  [
    hostname: string,
    path: string,
    tunnelName: string | undefined,
    forwardedPath: string | undefined,
  ]
> = [
  ["captun.account.workers.dev", "/my-test/hello", "my-test", "/hello"],
  ["captun.account.workers.dev", "/my-test/__captun-connect", "my-test", "/__captun-connect"],
  ["captun.account.workers.dev", "/__captun-connect", undefined, undefined],
  ["captun.account.workers.dev", "/", undefined, undefined],
  ["localhost", "/my-test/hello", "my-test", "/hello"],
  ["my-tunnels.com", "/my-test/hello", "my-test", "/hello"],
  ["tunnels.example.com", "/my-test/hello", "my-test", "/hello"],
  ["tunnels.example.com", "/my-test/__captun-connect", "my-test", "/__captun-connect"],
  ["my-test.tunnels.example.com", "/hello", "my-test", "/hello"],
  ["my-test.my-tunnels.com", "/hello", "my-test", "/hello"],
  ["my-test.my-tunnels.com", "/__captun-connect", "my-test", "/__captun-connect"],
  ["my-test.mysubdomain.mydomain.com", "/hello", "my-test", "/hello"],
  ["some-tunnel.example.com", "/some-path", "some-tunnel", "/some-path"],
  ["captun.account.workers.dev", "/bad%/hello", undefined, undefined],
];

test.each(routeCases)("%s%s -> %s %s", (hostname, path, tunnelName, forwardedPath) => {
  expect(captunRouteParts(hostname, path)).toEqual(
    tunnelName ? { name: tunnelName, path: forwardedPath } : undefined,
  );
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

test("Captun Worker returns 503 when a named tunnel has no connected client", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/missing/hello`);

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test("Captun Worker routes subdomain tunnel requests", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fixture.worker.fetch("http://demo.tunnels.example.com/hello");

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test("Captun Worker rejects missing tunnel names before Durable Object dispatch", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/__captun-connect`);

  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker rejects malformed folder tunnel names", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/bad%/hello`);

  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker requires the configured secret before accepting a tunnel client", async () => {
  await using fixture = await createCaptunWorkerFixture({ CAPTUN_SECRET: "secret" });

  const response = await fetch(`${fixture.origin}/demo/__captun-connect`);

  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized\n");
});
