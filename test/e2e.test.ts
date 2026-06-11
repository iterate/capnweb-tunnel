import { createHash } from "node:crypto";

import { createRouterClient } from "@orpc/server";
import { newWebSocketRpcSession } from "capnweb";
import { expect, test, vi } from "vitest";

import { createCaptunCliRouter } from "../src/cli/bin.js";
import {
  createCaptunTunnel,
  createWebSocketResponse,
  isWebSocketUpgradeRequest,
  WebSocketPair,
} from "../src/index.js";
import {
  createCaptunWorkerFixture,
  createHostedCaptunWorkerFixture,
  createMiniflareWorkerFixture,
} from "./miniflare.js";

vi.setConfig({ testTimeout: 15_000 });

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

// Binary frames are covered by the CLI test below: miniflare's getWorker()
// fetch proxy used here corrupts binary WebSocket messages to "[object Blob]".
test.concurrent("forwards WebSocket messages, subprotocols, and close codes", async ({ task }) => {
  await using target = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
  await using tunnel = await createTunnelFixture(task.name, (request) =>
    target.worker.fetch(request.url, request),
  );

  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"), ["alpha", "beta"]);
  await waitForWebSocket(socket);
  expect(socket).toMatchObject({ protocol: "alpha" });
  const closed = nextWebSocketClose(socket);

  socket.send("ping");
  await expect(nextWebSocketMessage(socket).then(webSocketMessageText)).resolves.toBe("echo:ping");

  socket.send("close-with:4001 done");
  await expect(closed).resolves.toMatchObject({ code: 4001, reason: "done" });
});

test.concurrent("forwards concurrent WebSockets over one tunnel without cross-talk", async ({
  task,
}) => {
  await using target = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
  await using tunnel = await createTunnelFixture(task.name, (request) =>
    target.worker.fetch(request.url, request),
  );

  const first = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"));
  const second = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"));
  await Promise.all([waitForWebSocket(first), waitForWebSocket(second)]);

  first.send("from-first");
  second.send("from-second");
  await expect(nextWebSocketMessage(first).then(webSocketMessageText)).resolves.toBe(
    "echo:from-first",
  );
  await expect(nextWebSocketMessage(second).then(webSocketMessageText)).resolves.toBe(
    "echo:from-second",
  );

  first.close();
  second.close();
  await delay(50);
});

// Workers-style WebSocket handling from a plain fetch handler running in
// Node, using the library's runtime-agnostic WebSocketPair — no workerd on
// the target side.
test.concurrent("answers WebSockets Workers-style from a Node fetch handler", async ({ task }) => {
  const serverClosed = Promise.withResolvers<{ code: number; reason: string }>();

  await using tunnel = await createTunnelFixture(task.name, (request) => {
    if (!isWebSocketUpgradeRequest(request)) return new Response("http ok\n");

    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    server.send("welcome");
    server.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data as string;
      if (data === "close-me") {
        server.close(4002, "client asked");
        return;
      }
      server.send(`node-echo:${data}`);
    });
    server.addEventListener("close", (event) => {
      const { code, reason } = event as { code?: number; reason?: string };
      serverClosed.resolve({ code: code ?? 0, reason: reason ?? "" });
    });
    return createWebSocketResponse(pair[0], { protocol: "node-pair" });
  });

  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"), ["node-pair"]);
  await waitForWebSocket(socket);
  expect(socket).toMatchObject({ protocol: "node-pair" });

  // The welcome was sent before the handler even returned; it must not be lost.
  await expect(nextWebSocketMessage(socket).then(webSocketMessageText)).resolves.toBe("welcome");

  socket.send("hello");
  await expect(nextWebSocketMessage(socket).then(webSocketMessageText)).resolves.toBe(
    "node-echo:hello",
  );

  // Server-initiated close reaches the public client with its code.
  const closed = nextWebSocketClose(socket);
  socket.send("close-me");
  await expect(closed).resolves.toMatchObject({ code: 4002, reason: "client asked" });
  await expect(serverClosed.promise).resolves.toMatchObject({ code: 4002 });
});

test.concurrent("fails the public WebSocket when the local server rejects it", async ({ task }) => {
  await using tunnel = await createTunnelFixture(
    task.name,
    () => new Response("No WebSockets here\n", { status: 404 }),
  );

  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"));
  await expect(waitForWebSocket(socket)).rejects.toThrow();
});

test.concurrent("closes public WebSockets when the tunnel client disconnects", async ({ task }) => {
  await using target = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
  await using server = await createServerFixture();
  const tunnel = await createCaptunTunnel({
    gateway: server.gateway,
    name: tunnelName(task.name),
    token: server.token,
    fetch: (request) => target.worker.fetch(request.url, request),
  });

  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"));
  await waitForWebSocket(socket);
  const closed = nextWebSocketClose(socket);

  tunnel[Symbol.dispose]();
  await expect(closed).resolves.toMatchObject({ code: 1001 });
});

test.concurrent("forwards WebSockets through the hosted gateway", async ({ task }) => {
  await using target = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
  await using gateway = await createHostedCaptunWorkerFixture();
  using tunnel = await createCaptunTunnel({
    gateway: gateway.origin,
    name: tunnelName(task.name),
    fetch: (request) => target.worker.fetch(request.url, request),
  });

  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"));
  await waitForWebSocket(socket);
  socket.send("hosted");
  await expect(nextWebSocketMessage(socket).then(webSocketMessageText)).resolves.toBe(
    "echo:hosted",
  );
  socket.close();
  await delay(50);
});

test("CLI tunnels WebSocket traffic to a local target", async ({ task }) => {
  await using app = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
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
    target: app.origin,
    gateway: server.gateway,
    name: tunnelName(task.name),
    token: server.token,
    requestLogs: false,
  });

  const tunnel = await ready.promise;
  const socket = new WebSocket(`${tunnel.url}/ws`.replace(/^http/, "ws"), {
    protocols: ["alpha", "beta"],
    headers: { cookie: "session=tunnel-test", authorization: "Bearer tunnel-test" },
    // Node's WebSocket (undici) accepts { protocols, headers }; the DOM type doesn't.
  } as unknown as string[]);
  try {
    await waitForWebSocket(socket);
    expect(socket).toMatchObject({ protocol: "alpha" });

    socket.send("handshake-headers");
    await expect(
      nextWebSocketMessage(socket).then(webSocketMessageText).then(JSON.parse),
    ).resolves.toMatchObject({
      cookie: "session=tunnel-test",
      authorization: "Bearer tunnel-test",
    });

    socket.send("hello-from-cli");
    await expect(nextWebSocketMessage(socket).then(webSocketMessageText)).resolves.toBe(
      "echo:hello-from-cli",
    );

    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    socket.send(bytes);
    await expect(nextWebSocketMessage(socket).then(webSocketMessageBytes)).resolves.toEqual(bytes);

    const closed = nextWebSocketClose(socket);
    socket.send("close-with:4001 done");
    await expect(closed).resolves.toMatchObject({ code: 4001, reason: "done" });
  } finally {
    socket.close();
    await delay(50);
    shutdown.resolve();
    await runTunnel;
  }
});

// Captun through Captun: the CLI exposes an entire inner gateway through an
// outer tunnel, so public traffic crosses two gateways and two tunnel clients
// before reaching the worker. (The inner tunnel still connects to its gateway
// directly: a Gateway Connect Request cannot ride through a tunnel because
// gateways claim any request carrying the connect query param before tunnel
// routing.)
test("tunnels Captun through Captun", async ({ task }) => {
  await using target = await createMiniflareWorkerFixture({
    entryPoint: "test/fixtures/capnweb-websocket-target.ts",
    durableObjects: {},
    bindings: {},
  });
  await using inner = await createTunnelFixture(`${task.name} inner`, (request) =>
    target.worker.fetch(request.url, request),
  );

  // The outer tunnel exposes the inner gateway like any local server.
  await using outerServer = await createServerFixture();
  const ready = Promise.withResolvers<{ url: string }>();
  const shutdown = Promise.withResolvers<void>();
  const router = createCaptunCliRouter({
    readConfig: async () => undefined,
    waitForShutdown: () => shutdown.promise,
    onTunnelReady: ({ url }) => ready.resolve({ url }),
  });
  const runTunnel = createRouterClient(router).tunnel({
    target: new URL(inner.url).origin,
    gateway: outerServer.gateway,
    name: tunnelName(`${task.name} outer`),
    token: outerServer.token,
    requestLogs: false,
  });

  const outer = await ready.promise;
  const nestedUrl = `${outer.url}${new URL(inner.url).pathname}`;
  const rpc = newWebSocketRpcSession<{ ping(value: string): Promise<string> }>(
    `${nestedUrl}/rpc`.replace(/^http/, "ws"),
  );
  const socket = new WebSocket(`${nestedUrl}/ws`.replace(/^http/, "ws"));
  try {
    await expect(rpc.ping("captun-through-captun")).resolves.toBe("pong:captun-through-captun");

    await waitForWebSocket(socket);
    socket.send("through-two-tunnels");
    await expect(nextWebSocketMessage(socket).then(webSocketMessageText)).resolves.toBe(
      "echo:through-two-tunnels",
    );
  } finally {
    socket.close();
    rpc[Symbol.dispose]();
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

function nextWebSocketClose(socket: WebSocket) {
  return new Promise<{ code: number; reason: string }>((resolveClose) => {
    socket.addEventListener(
      "close",
      (event) => {
        const { code, reason } = event as { code?: number; reason?: string };
        resolveClose({ code: code ?? 0, reason: reason ?? "" });
      },
      { once: true },
    );
  });
}

async function webSocketMessageText(data: unknown) {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(await webSocketMessageBytes(data));
}

async function webSocketMessageBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return new Uint8Array(data);
  throw new Error(
    `Expected a binary WebSocket message, got ${typeof data}: ${JSON.stringify(data)?.slice(0, 200)}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
