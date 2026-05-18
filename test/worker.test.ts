import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";
import { expect, test } from "vitest";
import { createCaptunTunnel } from "../src/client.ts";

test("Captun Worker forwards requests through a real Durable Object tunnel", async () => {
  await using fixture = await createWorkerFixture();
  using _tunnel = await createCaptunTunnel({
    url: new URL("/demo/__connect", fixture.origin),
    fetch: async (request) => {
      const url = new URL(request.url);
      return Response.json({
        path: url.pathname,
        body: await request.text(),
      });
    },
  });

  const response = await fetch(new URL("/demo/hello", fixture.origin), {
    method: "POST",
    body: "hello through miniflare",
  });

  expect(await response.json()).toMatchObject({
    path: "/hello",
    body: "hello through miniflare",
  });
});

test("Captun Worker returns 503 when a named tunnel has no connected client", async () => {
  await using fixture = await createWorkerFixture();

  const response = await fetch(new URL("/missing/hello", fixture.origin));

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test("Captun Worker routes subdomain tunnel requests", async () => {
  await using fixture = await createWorkerFixture();

  const response = await fixture.worker.fetch("http://demo.tunnels.example.com/hello");

  expect(response.status).toBe(503);
  expect(await response.text()).toBe("No tunnel client connected\n");
});

test("Captun Worker rejects missing tunnel names before Durable Object dispatch", async () => {
  await using fixture = await createWorkerFixture();

  const response = await fetch(new URL("/__connect", fixture.origin));

  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker rejects malformed folder tunnel names", async () => {
  await using fixture = await createWorkerFixture();

  const response = await fetch(new URL("/bad%/hello", fixture.origin));

  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Missing tunnel name\n");
});

test("Captun Worker requires the configured secret before accepting a tunnel client", async () => {
  await using fixture = await createWorkerFixture({ CAPTUN_SECRET: "secret" });

  const response = await fetch(new URL("/demo/__connect", fixture.origin));

  expect(response.status).toBe(401);
  expect(await response.text()).toBe("Unauthorized\n");
});

async function createWorkerFixture(bindings: Record<string, string> = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "captun-miniflare-"));
  await esbuild.build({
    entryPoints: ["dist/worker.js"],
    outfile: join(tempDir, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
  });

  const miniflare = new Miniflare({
    modules: true,
    rootPath: tempDir,
    modulesRoot: tempDir,
    scriptPath: "worker.js",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2024-04-03",
    durableObjects: {
      CaptunServerShard: { className: "CaptunServerShard" },
    },
    bindings,
  });
  const url = await miniflare.ready;
  const worker = (await miniflare.getWorker()) as unknown as WorkerFetcherLike;

  return {
    origin: url.origin,
    worker,
    async [Symbol.asyncDispose]() {
      await miniflare.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

interface WorkerFetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
