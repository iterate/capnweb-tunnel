import { expect, test } from "vitest";
import { createCaptunTunnel } from "../src/client.js";
import {
  CAPTUN_ACTIVE_TUNNEL_COOKIE,
  captunActiveTunnelSetCookie,
  captunCookieWithoutRoutingCookie,
  captunRequestRouteParts,
  captunRouteParts,
  captunShardName,
} from "../src/worker-routing.js";
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

test("Captun request routing selects a folder-host active tunnel cookie", () => {
  expect(
    captunRequestRouteParts(
      "captun.account.workers.dev",
      "/assets/app.js",
      `${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo`,
    ),
  ).toEqual({
    kind: "tunnel",
    name: "demo",
    path: "/assets/app.js",
    rootedByCookie: true,
  });
});

test("Captun request routing keeps folder-host direct links stateless without a cookie", () => {
  expect(captunRequestRouteParts("captun.account.workers.dev", "/demo/hello", "")).toEqual({
    kind: "tunnel",
    name: "demo",
    path: "/hello",
    rootedByCookie: false,
  });
});

test("Captun request routing does not let direct path names steal cookie-rooted paths", () => {
  expect(
    captunRequestRouteParts(
      "captun.account.workers.dev",
      "/other/hello",
      `${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo`,
    ),
  ).toEqual({
    kind: "tunnel",
    name: "demo",
    path: "/other/hello",
    rootedByCookie: true,
  });
});

test("Captun request routing keeps tunnel connect paths direct even with an active cookie", () => {
  expect(
    captunRequestRouteParts(
      "captun.account.workers.dev",
      "/other/__captun-connect",
      `${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo`,
    ),
  ).toEqual({
    kind: "tunnel",
    name: "other",
    path: "/__captun-connect",
    rootedByCookie: false,
  });
});

test("Captun request routing treats the folder-host selector path as reserved", () => {
  expect(captunRequestRouteParts("captun.account.workers.dev", "/__captun/t/demo", "")).toEqual({
    kind: "select-active-tunnel",
    name: "demo",
  });
  expect(
    captunRequestRouteParts(
      "captun.account.workers.dev",
      "/__captun/unknown",
      `${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo`,
    ),
  ).toBeUndefined();
});

test("Captun request routing skips cookie selection for subdomain-routed tunnels", () => {
  expect(captunRequestRouteParts("demo.tunnels.example.com", "/__captun/t/other", "")).toEqual({
    kind: "tunnel",
    name: "demo",
    path: "/__captun/t/other",
    rootedByCookie: false,
  });
});

test("Captun active tunnel cookie is host-scoped and secure only for HTTPS", () => {
  const httpCookie = captunActiveTunnelSetCookie("demo tunnel", "http:");
  expect(httpCookie).toContain(`${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo%20tunnel`);
  expect(httpCookie).toContain("Path=/");
  expect(httpCookie).toContain("Max-Age=3600");
  expect(httpCookie).toContain("HttpOnly");
  expect(httpCookie).toContain("SameSite=Lax");
  expect(httpCookie).not.toContain("Domain=");
  expect(httpCookie).not.toContain("Secure");

  expect(captunActiveTunnelSetCookie("demo", "https:")).toContain("Secure");
});

test("Captun routing cookie stripping keeps origin cookies intact", () => {
  expect(
    captunCookieWithoutRoutingCookie(
      `session=abc; ${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo; theme=light%20mode`,
    ),
  ).toBe("session=abc; theme=light%20mode");
  expect(captunCookieWithoutRoutingCookie(`${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo`)).toBe("");
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

test("Captun Worker selector sets an active tunnel cookie and redirects to root", async () => {
  await using fixture = await createCaptunWorkerFixture({});

  const response = await fetch(`${fixture.origin}/__captun/t/demo`, { redirect: "manual" });

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toContain(`${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo`);
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
});

test("Captun Worker routes folder-rooted browser paths through the active tunnel cookie", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _tunnel = await createCaptunTunnel({
    url: `${fixture.origin}/demo/__captun-connect`,
    fetch: async (request) => {
      const url = new URL(request.url);
      return Response.json({
        path: url.pathname,
        cookie: request.headers.get("cookie"),
      });
    },
  });

  const selectorResponse = await fetch(`${fixture.origin}/__captun/t/demo`, { redirect: "manual" });
  const activeTunnelCookie = cookiePair(selectorResponse.headers.get("set-cookie") || "");
  const response = await fetch(`${fixture.origin}/assets/app.js`, {
    headers: { cookie: `${activeTunnelCookie}; session=origin` },
  });

  expect(response.headers.get("vary")).toContain("Cookie");
  expect(await response.json()).toMatchObject({
    path: "/assets/app.js",
    cookie: "session=origin",
  });
});

test("Captun Worker keeps same-host path names from stealing cookie-rooted requests", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _demoTunnel = await createCaptunTunnel({
    url: `${fixture.origin}/demo/__captun-connect`,
    fetch: async (request) => Response.json({ tunnel: "demo", path: new URL(request.url).pathname }),
  });
  using _otherTunnel = await createCaptunTunnel({
    url: `${fixture.origin}/other/__captun-connect`,
    fetch: async (request) => Response.json({ tunnel: "other", path: new URL(request.url).pathname }),
  });

  const response = await fetch(`${fixture.origin}/other/hello`, {
    headers: { cookie: `${CAPTUN_ACTIVE_TUNNEL_COOKIE}=demo` },
  });

  expect(await response.json()).toMatchObject({
    tunnel: "demo",
    path: "/other/hello",
  });
});

test("Captun Worker forwards selector-looking paths on subdomain-routed tunnels", async () => {
  await using fixture = await createCaptunWorkerFixture({});
  using _tunnel = await createCaptunTunnel({
    url: `${fixture.origin}/demo/__captun-connect`,
    fetch: async (request) => Response.json({ path: new URL(request.url).pathname }),
  });

  const response = await fixture.worker.fetch("http://demo.tunnels.example.com/__captun/t/other");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ path: "/__captun/t/other" });
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

function cookiePair(setCookieHeader: string) {
  const [pair] = setCookieHeader.split(";");
  if (!pair) throw new Error("Missing Set-Cookie pair");
  return pair;
}
