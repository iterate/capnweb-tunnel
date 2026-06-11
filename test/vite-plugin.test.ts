import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, preview, type Plugin } from "vite";
import { expect, test, vi } from "vitest";

import type { TunnelReady } from "../src/index.js";
import captun from "../src/vite.js";
import { createCaptunWorkerFixture } from "./miniflare.js";

vi.setConfig({ testTimeout: 15_000 });

test.concurrent("serves the dev server through a tunnel", async () => {
  await using fixture = await createDevServerFixture();

  const response = await fetch(fixture.tunnel.url);
  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toContain("captun vite fixture");
});

test.concurrent("reports the tunnel through onTunnel", async () => {
  await using fixture = await createDevServerFixture();

  expect(fixture.tunnel).toMatchObject({ url: `${fixture.gateway}/${fixture.name}` });
});

test.concurrent("forwards request bodies", async () => {
  await using fixture = await createDevServerFixture();

  const response = await fetch(`${fixture.tunnel.url}/echo`, {
    method: "POST",
    body: "hello through vite",
  });
  expect(await response.json()).toMatchObject({ method: "POST", body: "hello through vite" });
});

test.concurrent("passes redirects through to the public client", async () => {
  await using fixture = await createDevServerFixture();

  const response = await fetch(`${fixture.tunnel.url}/redirect`, { redirect: "manual" });
  expect(response).toMatchObject({ status: 302 });
  expect(response.headers.get("location")).toBe("/after");
});

test.concurrent("closes the tunnel when the server closes", async () => {
  await using fixture = await createDevServerFixture();

  expect(await fetch(fixture.tunnel.url)).toMatchObject({ status: 200 });
  await fixture.server.close();

  await expect
    .poll(async () => (await fetch(fixture.tunnel.url)).status)
    .toBeGreaterThanOrEqual(400);
});

test.concurrent("creates no tunnel when disabled", async () => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const name = tunnelName();

  const server = await createServer({
    root: root.path,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [captun({ gateway: worker.origin, name, enabled: false })],
  });
  try {
    await server.listen();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await fetch(`${worker.origin}/${name}`)).status).toBeGreaterThanOrEqual(400);
  } finally {
    await server.close();
  }
});

test.concurrent("serves vite preview through a tunnel", async () => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  await mkdir(join(root.path, "dist"));
  await writeFile(
    join(root.path, "dist", "index.html"),
    "<!doctype html><h1>captun preview fixture</h1>\n",
  );
  const ready = Promise.withResolvers<TunnelReady>();

  const server = await preview({
    root: root.path,
    configFile: false,
    logLevel: "silent",
    preview: { port: 0 },
    plugins: [captun({ gateway: worker.origin, name: tunnelName(), onTunnel: ready.resolve })],
  });
  try {
    const tunnel = await ready.promise;
    const response = await fetch(tunnel.url);
    expect(response).toMatchObject({ status: 200 });
    expect(await response.text()).toContain("captun preview fixture");
  } finally {
    await server.close();
  }
});

async function createDevServerFixture() {
  const worker = await createCaptunWorkerFixture({});
  const root = await createAppFixture();
  const name = tunnelName();
  const ready = Promise.withResolvers<TunnelReady>();

  const server = await createServer({
    root: root.path,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [testEndpoints(), captun({ gateway: worker.origin, name, onTunnel: ready.resolve })],
  });
  try {
    await server.listen();
    const tunnel = await ready.promise;
    return {
      server,
      tunnel,
      name,
      gateway: worker.origin,
      async [Symbol.asyncDispose]() {
        await server.close();
        await worker[Symbol.asyncDispose]();
        await root[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await server.close();
    await worker[Symbol.asyncDispose]();
    await root[Symbol.asyncDispose]();
    throw error;
  }
}

async function createAppFixture() {
  const path = await mkdtemp(join(tmpdir(), "captun-vite-"));
  await writeFile(join(path, "index.html"), "<!doctype html><h1>captun vite fixture</h1>\n");
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function testEndpoints(): Plugin {
  return {
    name: "captun-test-endpoints",
    configureServer(server) {
      server.middlewares.use("/echo", (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString() }),
          );
        });
      });
      server.middlewares.use("/redirect", (_request, response) => {
        response.statusCode = 302;
        response.setHeader("location", "/after");
        response.end();
      });
    },
  };
}

function tunnelName() {
  return `vite-plugin-${randomBytes(6).toString("hex")}`;
}
