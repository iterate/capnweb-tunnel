import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { createRouterClient } from "@orpc/server";
import { newWebSocketRpcSession } from "capnweb";
import { expect, test, vi } from "vitest";

import { createCaptunCliRouter } from "../src/cli/bin.js";
import { createCaptunTunnel } from "../src/index.js";
import { createCaptunWorkerFixture, createMiniflareWorkerFixture } from "./miniflare.js";

vi.setConfig({ testTimeout: 25_000 });

test.concurrent("forwards HTTP", async ({ task }) => {
  await using tunnel = await createTunnelFixture(task.name, async (request) =>
    Response.json({ body: await request.text() }),
  );

  const response = await fetch(tunnel.url, {
    method: "POST",
    body: "hello through tunnel",
  });
  expect(await response.json()).toMatchObject({ body: "hello through tunnel" });
});

test.concurrent("creates a named tunnel from a gateway", async ({ task }) => {
  await using server = await createServerFixture();
  const name = tunnelName(task.name);
  using tunnel = await createCaptunTunnel({
    gateway: server.gateway,
    name,
    token: server.token,
    fetch: async (request) => {
      const url = new URL(request.url);
      return Response.json({ path: url.pathname, body: await request.text() });
    },
  });

  expect(tunnel).toMatchObject({ token: server.token });
  if (server.tunnelUrl) expect(tunnel).toMatchObject({ url: server.tunnelUrl(name) });

  const response = await fetch(`${tunnel.url}/gateway-api`, {
    method: "POST",
    body: "hello through gateway",
  });

  expect(await response.json()).toMatchObject({
    path: "/gateway-api",
    body: "hello through gateway",
  });
});

test.concurrent("streams a binary response", async ({ task }) => {
  await using tunnel = await createTunnelFixture(task.name, () => {
    let sent = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          sent += 1;
          controller.enqueue(new Uint8Array(65_536));
          if (sent === 8) controller.close();
        },
      }),
      { headers: { "content-type": "application/octet-stream" } },
    );
  });

  const response = await fetch(tunnel.url);
  expect(response).toMatchObject({ status: 200 });

  if (!response.body) throw new Error("Response has no body");
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.byteLength;
  expect(bytes).toBe(524_288);
});

test.concurrent("streams SSE events", async ({ task }) => {
  await using tunnel = await createTunnelFixture(task.name, () => {
    const events = Array.from(
      { length: 5 },
      (_, i) => `event: tunnel\nid: ${i + 1}\ndata: ${i + 1}\n\n`,
    );
    return new Response(events.join(""), {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  });

  const response = await fetch(tunnel.url);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect((await response.text()).match(/^event: tunnel$/gm)).toHaveLength(5);
});

test.concurrent("streams response chunks before the local fetcher finishes", async ({ task }) => {
  const encoder = new TextEncoder();
  const secondChunk = Promise.withResolvers<void>();

  await using tunnel = await createTunnelFixture(task.name, () => {
    async function* events() {
      yield encoder.encode("first\n");
      await secondChunk.promise;
      yield encoder.encode("second\n");
    }

    return new Response(
      new ReadableStream({
        async start(controller) {
          for await (const chunk of events()) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream; charset=utf-8" } },
    );
  });

  const response = await fetch(tunnel.url);
  if (!response.body) throw new Error("Response has no body");

  const reader = response.body.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe("first\n");

  secondChunk.resolve();

  const second = await reader.read();
  expect(new TextDecoder().decode(second.value)).toBe("second\n");

  const done = await reader.read();
  expect(done).toMatchObject({ done: true });
});

test.concurrent("uploads a raw file body", async ({ task }) => {
  await using tunnel = await createTunnelFixture(task.name, async (request) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return Response.json({ bytes: bytes.byteLength, sha256: sha256(bytes) });
  });

  const bytes = makeBytes(1024 * 1024);
  const response = await fetch(tunnel.url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes.buffer,
  });
  expect(await response.json()).toMatchObject({
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
});

test.concurrent("uploads multipart form data", async ({ task }) => {
  await using tunnel = await createTunnelFixture(task.name, async (request) => {
    const form = await request.formData();
    const parts = [];
    for (const [name, value] of form.entries() as Iterable<[string, string | Blob]>) {
      if (typeof value === "string") parts.push({ name, value });
      else
        parts.push({
          name,
          bytes: value.size,
          sha256: sha256(new Uint8Array(await value.arrayBuffer())),
        });
    }
    return Response.json({ parts });
  });

  const file = makeBytes(256 * 1024);
  const form = new FormData();
  form.set("name", "multipart-proof");
  form.set("file", new Blob([file.buffer]), "proof.bin");

  const response = await fetch(tunnel.url, { method: "POST", body: form });
  expect(await response.json()).toMatchObject({
    parts: expect.arrayContaining([
      { name: "name", value: "multipart-proof" },
      { name: "file", bytes: file.byteLength, sha256: sha256(file) },
    ]),
  });
});

test.concurrent("forwards WebSocket Cap'n Web RPC to a local fetch handler", async ({ task }) => {
  await using target = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
  await using tunnel = await createTunnelFixture(task.name, (request) =>
    target.worker.fetch(request.url, request),
  );

  const rpc = newWebSocketRpcSession<{ ping(value: string): Promise<string> }>(
    `${tunnel.url}/rpc`.replace(/^http/, "ws"),
  );

  await expect(rpc.ping("dummy-capability")).resolves.toBe("pong:dummy-capability");
  rpc[Symbol.dispose]();
  await delay(50);
});

test("CLI tunnels WebSocket traffic to a local Bun server", async ({ task }) => {
  await using app = await createBunWebSocketFixture();
  await using server = await createServerFixture();
  const ready = Promise.withResolvers<{ url: string }>();
  const shutdown = Promise.withResolvers<void>();
  const router = createCaptunCliRouter({
    readConfig: async () => undefined,
    waitForShutdown: () => shutdown.promise,
    onTunnelReady: ({ url }) => ready.resolve({ url }),
  });
  const client = createRouterClient(router);

  const runTunnel = client.tunnel({
    target: String(app.port),
    gateway: server.gateway,
    name: tunnelName(task.name),
    token: server.token,
    requestLogs: false,
  });

  const tunnel = await ready.promise;
  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"));
  try {
    await waitForWebSocket(socket);
    socket.send("hello-from-cli");
    await expect(readWebSocketMessage(socket)).resolves.toBe("echo:hello-from-cli");
  } finally {
    socket.close();
    await delay(50);
    shutdown.resolve();
    await runTunnel;
  }
});

async function createTunnelFixture(
  testName: string,
  fetch: (request: Request) => Response | Promise<Response>,
) {
  const server = await createServerFixture();
  const name = tunnelName(testName);
  try {
    const tunnel = await createCaptunTunnel({
      gateway: server.gateway,
      name,
      token: server.token,
      fetch,
    });
    return {
      url: tunnel.url,
      async [Symbol.asyncDispose]() {
        tunnel[Symbol.dispose]();
        await server[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await server[Symbol.asyncDispose]();
    throw error;
  }
}

async function createServerFixture() {
  if (process.env.CAPTUN_GATEWAY) {
    return {
      gateway: process.env.CAPTUN_GATEWAY,
      token: process.env.CAPTUN_TOKEN,
      tunnelUrl: undefined,
      async [Symbol.asyncDispose]() {},
    };
  }

  const worker = await createCaptunWorkerFixture({});
  return {
    gateway: worker.origin,
    token: undefined,
    tunnelUrl: (name: string) => `${worker.origin}/${name}`,
    async [Symbol.asyncDispose]() {
      await worker[Symbol.asyncDispose]();
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

function makeBytes(size: number) {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createBunWebSocketFixture() {
  const port = await getAvailablePort();
  const server = spawn("bun", ["run", "test/fixtures/bun-websocket-server.js"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = captureOutput(server);

  try {
    await waitForTcp(port, server, output);
    return {
      port,
      async [Symbol.asyncDispose]() {
        await stopProcess(server);
      },
    };
  } catch (error) {
    await stopProcess(server);
    throw new Error(
      formatFixtureFailure(error instanceof Error ? error.message : String(error), output.logs()),
    );
  }
}

type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

async function getAvailablePort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`Failed to allocate a local port: ${String(address)}`));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForTcp(port: number, server: ServerProcess, output: CapturedProcessOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const error = output.error();
    if (error) throw error;
    if (server.exitCode !== null || server.signalCode) {
      throw new Error(
        `Bun server exited before port ${port} accepted connections\n\n${output.logs().trim() || "(none)"}`,
      );
    }

    if (await canConnect(port)) return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for Bun server to accept connections on port ${port}`);
}

function canConnect(port: number) {
  return new Promise<boolean>((resolveConnect) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveConnect(false);
    });
  });
}

function captureOutput(child: ServerProcess) {
  const chunks: string[] = [];
  let processError: Error | undefined;
  const capture = (chunk: string | Buffer) => {
    chunks.push(String(chunk));
    if (chunks.length > 200) chunks.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    processError = error;
    chunks.push(error.stack || error.message);
  });

  return {
    logs: () => chunks.join(""),
    error: () => processError,
  };
}

interface CapturedProcessOutput {
  logs(): string;
  error(): Error | undefined;
}

function formatFixtureFailure(message: string, serverLogs: string) {
  return [message, "", "Server logs:", serverLogs.trim() || "(none)"].join("\n");
}

async function stopProcess(child: ServerProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;

  child.kill("SIGINT");
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(5_000).then(() => false),
  ]);

  if (!exited && child.exitCode === null && !child.killed) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
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

function readWebSocketMessage(socket: WebSocket) {
  return new Promise<string>((resolveMessage, rejectMessage) => {
    socket.addEventListener(
      "message",
      async (event) => {
        resolveMessage(await webSocketMessageText(event.data));
      },
      { once: true },
    );
    socket.addEventListener("error", () => rejectMessage(new Error("WebSocket error")), {
      once: true,
    });
    socket.addEventListener("close", () => rejectMessage(new Error("WebSocket closed")), {
      once: true,
    });
  });
}

async function webSocketMessageText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
