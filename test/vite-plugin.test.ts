import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, createServer, preview, type Plugin } from "vite";
import { expect, test, vi } from "vitest";

import type { TunnelReady } from "../src/index.js";
import captun from "../src/vite.js";
import { createCaptunWorkerFixture } from "./miniflare.js";

vi.setConfig({ testTimeout: 15_000 });

test.concurrent("serves the dev server through a tunnel", async ({ task }) => {
  await using fixture = await createDevServerFixture(task.name);

  expect(fixture.tunnel).toMatchObject({ url: `${fixture.gateway}/${fixture.name}` });
  const response = await fetch(fixture.tunnel.url);
  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toContain("captun vite fixture");
});

test.concurrent("forwards request bodies", async ({ task }) => {
  await using fixture = await createDevServerFixture(task.name);

  const response = await fetch(`${fixture.tunnel.url}/echo`, {
    method: "POST",
    body: "hello through vite",
  });
  expect(await response.json()).toMatchObject({ method: "POST", body: "hello through vite" });
});

test.concurrent("passes redirects through to the public client", async ({ task }) => {
  await using fixture = await createDevServerFixture(task.name);

  const response = await fetch(`${fixture.tunnel.url}/redirect`, { redirect: "manual" });
  expect(response).toMatchObject({ status: 302 });
  expect(response.headers.get("location")).toBe("/after");
});

test.concurrent("closes the tunnel when the server closes", async ({ expect, task }) => {
  await using fixture = await createDevServerFixture(task.name);

  expect(await fetch(fixture.tunnel.url)).toMatchObject({ status: 200 });
  await fixture.server.close();

  await expect
    .poll(async () => (await fetch(fixture.tunnel.url)).status)
    .toBeGreaterThanOrEqual(400);
});

test.concurrent("prints the tunnel URL with Vite's logger by default", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const lines: string[] = [];
  const logger = createLogger("silent");
  logger.info = (message) => {
    lines.push(message);
  };

  const server = await createServer({
    root: root.path,
    configFile: false,
    customLogger: logger,
    server: { port: 0 },
    plugins: [captun({ gateway: worker.origin, name: tunnelName(task.name) })],
  });
  try {
    await server.listen();
    await expect.poll(() => lines.some((line) => line.includes("Captun:"))).toBe(true);
    const url = lines
      .find((line) => line.includes("Captun:"))!
      .split("Captun:")[1]
      .trim();
    expect(await (await fetch(url)).text()).toContain("captun vite fixture");
  } finally {
    await server.close();
  }
});

test.concurrent("tunnels through a self-hosted gateway that requires a Gateway Secret", async ({
  task,
}) => {
  await using fixture = await createDevServerFixture(task.name, {
    bindings: { CAPTUN_TOKEN: "gateway-secret" },
    token: "gateway-secret",
  });

  const response = await fetch(fixture.tunnel.url);
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toContain("captun vite fixture");
});

test.concurrent("reports a rejected Connect Token through onError", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "gateway-secret" });
  await using root = await createAppFixture();
  const errors: unknown[] = [];

  const server = await createServer({
    root: root.path,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [
      captun({
        gateway: worker.origin,
        name: tunnelName(task.name),
        token: "wrong-token",
        onError: (error) => errors.push(error),
      }),
    ],
  });
  try {
    await server.listen();
    await expect.poll(() => errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ name: "CaptunTunnelConnectError" });
  } finally {
    await server.close();
  }
});

test.concurrent("logs tunnel failures with Vite's logger by default", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "gateway-secret" });
  await using root = await createAppFixture();
  const errors: string[] = [];
  const logger = createLogger("silent");
  logger.error = (message) => {
    errors.push(message);
  };

  const server = await createServer({
    root: root.path,
    configFile: false,
    customLogger: logger,
    server: { port: 0 },
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), token: "wrong-token" }),
    ],
  });
  try {
    await server.listen();
    await expect.poll(() => errors.join("\n")).toContain("Captun tunnel failed");
  } finally {
    await server.close();
  }
});

test.concurrent("serves vite preview through a tunnel", async ({ task }) => {
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
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
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

async function createDevServerFixture(
  testName: string,
  options: { bindings?: Record<string, string>; token?: string } = {},
) {
  const worker = await createCaptunWorkerFixture(options.bindings ?? {});
  const root = await createAppFixture();
  const name = tunnelName(testName);
  const ready = Promise.withResolvers<TunnelReady>();

  const server = await createServer({
    root: root.path,
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    plugins: [
      testEndpoints(),
      captun({ gateway: worker.origin, name, token: options.token, onTunnel: ready.resolve }),
    ],
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

function tunnelName(testName: string) {
  const seed = `${testName}-${process.pid}-${Date.now()}-${Math.random()}`;
  const slug = testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const prefix = slug.slice(0, 32).replace(/-$/, "") || "test";
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}
