import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, createServer, preview, type InlineConfig, type Plugin } from "vite";
import { expect, test, vi } from "vitest";

import type { TunnelReady } from "../src/index.js";
import captun from "../src/vite.js";
import { createCaptunWorkerFixture } from "./miniflare.js";

vi.setConfig({ testTimeout: 15_000 });

test.concurrent("serves the dev server through a tunnel", async ({ task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const name = tunnelName(task.name);
  const ready = Promise.withResolvers<TunnelReady>();
  await using _server = await devServer({
    root: root.path,
    plugins: [captun({ gateway: worker.origin, name, onTunnel: ready.resolve })],
  });

  const tunnel = await ready.promise;
  expect(tunnel).toMatchObject({ url: `${worker.origin}/${name}` });

  const response = await fetch(tunnel.url);
  expect(response).toMatchObject({ status: 200 });
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(await response.text()).toContain("captun vite fixture");
});

test.concurrent("forwards Vite HMR WebSockets through a tunnel", async ({ task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const ready = Promise.withResolvers<TunnelReady>();
  await using server = await devServer({
    root: root.path,
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
  });

  const tunnel = await ready.promise;
  const socket = new WebSocket(
    `${tunnel.url}/?token=${server.config.webSocketToken}`.replace(/^http/, "ws"),
    "vite-hmr",
  );
  try {
    await waitForWebSocket(socket);
    await expect(nextWebSocketMessage(socket).then(webSocketMessageJson)).resolves.toMatchObject({
      type: "connected",
    });
  } finally {
    socket.close();
  }
});

test.concurrent("forwards request bodies", async ({ task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const echo: Plugin = {
    name: "echo-endpoint",
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
    },
  };
  const ready = Promise.withResolvers<TunnelReady>();
  await using _server = await devServer({
    root: root.path,
    plugins: [
      echo,
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
  });

  const tunnel = await ready.promise;
  const response = await fetch(`${tunnel.url}/echo`, {
    method: "POST",
    body: "hello through vite",
  });
  expect(await response.json()).toMatchObject({ method: "POST", body: "hello through vite" });
});

test.concurrent("passes redirects through to the public client", async ({ task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const redirect: Plugin = {
    name: "redirect-endpoint",
    configureServer(server) {
      server.middlewares.use("/redirect", (_request, response) => {
        response.statusCode = 302;
        response.setHeader("location", "/after");
        response.end();
      });
    },
  };
  const ready = Promise.withResolvers<TunnelReady>();
  await using _server = await devServer({
    root: root.path,
    plugins: [
      redirect,
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
  });

  const tunnel = await ready.promise;
  const response = await fetch(`${tunnel.url}/redirect`, { redirect: "manual" });
  expect(response).toMatchObject({ status: 302 });
  expect(response.headers.get("location")).toBe("/after");
});

test.concurrent("answers the reserved health path itself", async ({ task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const ready = Promise.withResolvers<TunnelReady>();
  await using _server = await devServer({
    root: root.path,
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
  });

  const tunnel = await ready.promise;
  const response = await fetch(`${tunnel.url}/__captun/health`);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

test.concurrent("closes the tunnel when the server closes", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const ready = Promise.withResolvers<TunnelReady>();
  await using server = await devServer({
    root: root.path,
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
  });

  const tunnel = await ready.promise;
  expect(await fetch(tunnel.url)).toMatchObject({ status: 200 });

  await server.close();
  // 503 is the gateway's "No tunnel client connected" response.
  await expect.poll(async () => (await fetch(tunnel.url)).status).toBe(503);
});

test.concurrent("prints the tunnel URL with Vite's logger by default", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({});
  await using root = await createAppFixture();
  const lines: string[] = [];
  const logger = createLogger("silent");
  logger.info = (message) => {
    lines.push(message);
  };
  await using _server = await devServer({
    root: root.path,
    customLogger: logger,
    plugins: [captun({ gateway: worker.origin, name: tunnelName(task.name) })],
  });

  await expect.poll(() => lines.some((line) => line.includes("Captun:"))).toBe(true);
  const url = lines
    .find((line) => line.includes("Captun:"))!
    .split("Captun:")[1]
    .trim();
  expect(await (await fetch(url)).text()).toContain("captun vite fixture");
});

test.concurrent("tunnels through a self-hosted gateway that requires a Gateway Secret", async ({
  task,
}) => {
  await using worker = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "gateway-secret" });
  await using root = await createAppFixture();
  const ready = Promise.withResolvers<TunnelReady>();
  await using _server = await devServer({
    root: root.path,
    plugins: [
      captun({
        gateway: worker.origin,
        name: tunnelName(task.name),
        token: "gateway-secret",
        onTunnel: ready.resolve,
      }),
    ],
  });

  const tunnel = await ready.promise;
  const response = await fetch(tunnel.url);
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toContain("captun vite fixture");
});

test.concurrent("reports a rejected Connect Token through onError", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "gateway-secret" });
  await using root = await createAppFixture();
  const errors: unknown[] = [];
  await using _server = await devServer({
    root: root.path,
    plugins: [
      captun({
        gateway: worker.origin,
        name: tunnelName(task.name),
        token: "wrong-token",
        onError: (error) => errors.push(error),
      }),
    ],
  });

  await expect.poll(() => errors.length).toBeGreaterThan(0);
  expect(errors[0]).toMatchObject({ name: "CaptunTunnelConnectError" });
});

test.concurrent("logs tunnel failures with Vite's logger by default", async ({ expect, task }) => {
  await using worker = await createCaptunWorkerFixture({ CAPTUN_TOKEN: "gateway-secret" });
  await using root = await createAppFixture();
  const errors: string[] = [];
  const logger = createLogger("silent");
  logger.error = (message) => {
    errors.push(message);
  };
  await using _server = await devServer({
    root: root.path,
    customLogger: logger,
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), token: "wrong-token" }),
    ],
  });

  await expect.poll(() => errors.join("\n")).toContain("Captun tunnel failed");
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
  await using _server = await previewServer({
    root: root.path,
    plugins: [
      captun({ gateway: worker.origin, name: tunnelName(task.name), onTunnel: ready.resolve }),
    ],
  });

  const tunnel = await ready.promise;
  const response = await fetch(tunnel.url);
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toContain("captun preview fixture");
});

/** `createServer` with the shared test boilerplate: quiet, random port, disposable. */
async function devServer(config: InlineConfig) {
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    server: { port: 0 },
    ...config,
  });
  await server.listen();
  return Object.assign(server, {
    async [Symbol.asyncDispose]() {
      await server.close();
    },
  });
}

/** `preview` with the shared test boilerplate: quiet, random port, disposable. */
async function previewServer(config: InlineConfig) {
  const server = await preview({
    configFile: false,
    logLevel: "silent",
    preview: { port: 0 },
    ...config,
  });
  return Object.assign(server, {
    async [Symbol.asyncDispose]() {
      await server.close();
    },
  });
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

function waitForWebSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("WebSocket error")), {
      once: true,
    });
    socket.addEventListener("close", () => rejectOpen(new Error("WebSocket closed")), {
      once: true,
    });
  });
}

function nextWebSocketMessage(socket: WebSocket) {
  return new Promise<unknown>((resolveMessage, rejectMessage) => {
    socket.addEventListener("message", (event) => resolveMessage(event.data), { once: true });
    socket.addEventListener("error", () => rejectMessage(new Error("WebSocket error")), {
      once: true,
    });
    socket.addEventListener("close", () => rejectMessage(new Error("WebSocket closed")), {
      once: true,
    });
  });
}

function webSocketMessageJson(data: unknown) {
  if (typeof data !== "string")
    throw new Error(`Expected text WebSocket message, got ${typeof data}`);
  return JSON.parse(data) as unknown;
}
