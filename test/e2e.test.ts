import { createHash } from "node:crypto";
import { describe, test, vi } from "vitest";
import WebSocket from "ws";
import { CapnwebTunnelClient } from "../src/client";

vi.setConfig({ testTimeout: 15_000 });

const serverUrl =
  process.env.TUNNEL_SERVER_URL ??
  "https://cheap-tunnel.garple-pretend-customer-should-be-iterate-dev-stg-will-chan.workers.dev";
const authHeaders =
  process.env.TUNNEL_USERNAME && process.env.TUNNEL_PASSWORD
    ? { authorization: basicAuth(process.env.TUNNEL_USERNAME, process.env.TUNNEL_PASSWORD) }
    : undefined;

describe("Cap'n Web tunnel e2e", () => {
  test.concurrent("forwards HTTP", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    const response = await fetch(new URL("hello", url), {
      method: "POST",
      headers: authHeaders,
      body: "hello through tunnel",
    });
    expect(await response.json()).toMatchObject({ path: "/hello", body: "hello through tunnel" });
    client.close();
  });

  test.concurrent("streams a binary response", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    const response = await fetch(new URL("stream", url), { headers: authHeaders });
    expect(response.status).toBe(200);
    expect(await readBytes(response)).toBe(2_097_152);
    client.close();
  });

  test.concurrent("streams SSE events", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    const response = await fetch(new URL("sse", url), { headers: authHeaders });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect((await response.text()).match(/^event: tunnel$/gm)).toHaveLength(5);
    client.close();
  });

  test.concurrent("uploads a raw file body", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    const bytes = makeBytes(1024 * 1024);
    const response = await fetch(new URL("upload", url), {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/octet-stream" },
      body: bytes.buffer,
    });
    expect(await response.json()).toMatchObject({ bytes: bytes.byteLength, sha256: sha256(bytes) });
    client.close();
  });

  test.concurrent("uploads multipart form data", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    const file = makeBytes(256 * 1024);
    const form = new FormData();
    form.set("name", "multipart-proof");
    form.set("file", new Blob([file.buffer]), "proof.bin");

    const response = await fetch(new URL("multipart", url), { method: "POST", headers: authHeaders, body: form });
    const json = (await response.json()) as { parts: Array<{ name: string; bytes?: number; sha256?: string }> };
    expect(json.parts.find((part) => part.name === "file")).toMatchObject({
      bytes: file.byteLength,
      sha256: sha256(file),
    });
    client.close();
  });

  test.concurrent("proxies WebSockets", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    await expect(websocketMessages(new URL("ws", url))).resolves.toEqual([
      JSON.stringify({ type: "open", source: "vitest-client" }),
      JSON.stringify({ type: "echo", message: "hello websocket", source: "vitest-client" }),
    ]);
    client.close();
  });
});

async function connectTunnel(testName: string) {
  const name = slug(`${testName}-${process.pid}-${Date.now()}-${Math.random()}`);
  const url = new URL(`/${name}/`, serverUrl);
  const client = new CapnwebTunnelClient(url, {
    fetch: testFetch,
    headers: authHeaders,
    websocket: async (_request, socket) => {
      await socket.send(JSON.stringify({ type: "open", source: "vitest-client" }));
      return {
        message: (message) =>
          socket.send(JSON.stringify({ type: "echo", message, source: "vitest-client" })),
        close: (code, reason) => socket.close(code, reason),
      };
    },
  });
  await client.connect();
  return { url, client };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function testFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = tunnelPath(url);
  if (path === "/stream") return streamResponse();
  if (path === "/sse") return sseResponse();
  if (path === "/upload") return uploadResponse(request);
  if (path === "/multipart") return multipartResponse(request);
  return Response.json({ path, body: await request.text() });
}

function tunnelPath(url: URL): string {
  return "/" + url.pathname.split("/").slice(2).join("/");
}

function streamResponse(): Response {
  let sent = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent++ === 32) return controller.close();
      controller.enqueue(new Uint8Array(65_536));
    },
  }), { headers: { "content-type": "application/octet-stream" } });
}

function sseResponse(): Response {
  return new Response(Array.from({ length: 5 }, (_, i) => `event: tunnel\nid: ${i + 1}\ndata: ${i + 1}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function uploadResponse(request: Request): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  return Response.json({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function multipartResponse(request: Request): Promise<Response> {
  const form = await request.formData();
  const parts = [];
  for (const [name, value] of form.entries() as Iterable<[string, string | File]>) {
    if (typeof value === "string") parts.push({ name, value });
    else parts.push({ name, bytes: value.size, sha256: sha256(new Uint8Array(await value.arrayBuffer())) });
  }
  return Response.json({ parts });
}

async function readBytes(response: Response): Promise<number> {
  let bytes = 0;
  for await (const chunk of response.body!) bytes += chunk.byteLength;
  return bytes;
}

function makeBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function websocketMessages(url: URL): Promise<string[]> {
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, undefined, { headers: authHeaders });
    const messages: string[] = [];
    const timer = setTimeout(() => reject(new Error("WebSocket timed out")), 5_000);
    socket.addEventListener("open", () => socket.send("hello websocket"));
    socket.addEventListener("message", (event) => {
      messages.push(String(event.data));
      if (messages.length === 2) {
        clearTimeout(timer);
        socket.close(1000, "done");
        resolve(messages);
      }
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket error")));
  });
}
