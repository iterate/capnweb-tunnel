import { createHash } from "node:crypto";
import { describe, test, vi } from "vitest";
import { CapnwebTunnelClient } from "../src/client";

vi.setConfig({ testTimeout: 15_000 });

const serverUrl = requiredEnv("TUNNEL_SERVER_URL");

describe("Capnweb tunnel e2e", () => {
  test.concurrent("forwards HTTP", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    try {
      const response = await fetch(new URL("hello", url), {
        method: "POST",
        body: "hello through tunnel",
      });
      expect(await response.json()).toMatchObject({ path: "/hello", body: "hello through tunnel" });
    } finally {
      client.close();
    }
  });

  test.concurrent("streams a binary response", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    try {
      const response = await fetch(new URL("stream", url));
      expect(response.status).toBe(200);
      expect(await readBytes(response)).toBe(2_097_152);
    } finally {
      client.close();
    }
  });

  test.concurrent("streams SSE events", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    try {
      const response = await fetch(new URL("sse", url));
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect((await response.text()).match(/^event: tunnel$/gm)).toHaveLength(5);
    } finally {
      client.close();
    }
  });

  test.concurrent("uploads a raw file body", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    try {
      const bytes = makeBytes(1024 * 1024);
      const response = await fetch(new URL("upload", url), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes.buffer,
      });
      expect(await response.json()).toMatchObject({ bytes: bytes.byteLength, sha256: sha256(bytes) });
    } finally {
      client.close();
    }
  });

  test.concurrent("uploads multipart form data", async ({ task, expect }) => {
    const { url, client } = await connectTunnel(task.name);
    try {
      const file = makeBytes(256 * 1024);
      const form = new FormData();
      form.set("name", "multipart-proof");
      form.set("file", new Blob([file.buffer]), "proof.bin");

      const response = await fetch(new URL("multipart", url), { method: "POST", body: form });
      expect(hasMultipartFilePart(await response.json(), file.byteLength, sha256(file))).toBe(true);
    } finally {
      client.close();
    }
  });

});

async function connectTunnel(testName: string) {
  const name = tunnelName(testName);
  const url = tunnelUrl(name);
  const client = new CapnwebTunnelClient(url, {
    secret: process.env.TUNNEL_SECRET,
    fetch: testFetch,
  });
  await client.connect();
  return { url, client };
}

function tunnelName(testName: string) {
  const seed = `${testName}-${process.pid}-${Date.now()}-${Math.random()}`;
  const prefix = slug(testName).slice(0, 32).replace(/-$/, "") || "test";
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

function tunnelUrl(name: string) {
  if (serverUrl.includes("{name}")) return new URL(serverUrl.replaceAll("{name}", name));

  const url = new URL(serverUrl);
  if (url.hostname.match(/^[^.]+\.tunnels\./)) {
    url.pathname = "/";
  } else {
    url.pathname = `/${name}/`;
  }
  return url;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hasMultipartFilePart(value: unknown, bytes: number, hash: string) {
  if (typeof value !== "object" || value === null) return false;
  const parts = Reflect.get(value, "parts");
  if (!Array.isArray(parts)) return false;
  return parts.some((part) => {
    if (typeof part !== "object" || part === null) return false;
    return Reflect.get(part, "name") === "file"
      && Reflect.get(part, "bytes") === bytes
      && Reflect.get(part, "sha256") === hash;
  });
}

async function testFetch(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/stream") return streamResponse();
  if (path === "/sse") return sseResponse();
  if (path === "/upload") return uploadResponse(request);
  if (path === "/multipart") return multipartResponse(request);
  return Response.json({ path, body: await request.text() });
}

function streamResponse() {
  let sent = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (sent++ === 32) return controller.close();
      controller.enqueue(new Uint8Array(65_536));
    },
  }), { headers: { "content-type": "application/octet-stream" } });
}

function sseResponse() {
  return new Response(Array.from({ length: 5 }, (_, i) => `event: tunnel\nid: ${i + 1}\ndata: ${i + 1}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

async function uploadResponse(request: Request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  return Response.json({ bytes: bytes.byteLength, sha256: sha256(bytes) });
}

async function multipartResponse(request: Request) {
  const form = await request.formData();
  const parts = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") parts.push({ name, value });
    else parts.push({ name, bytes: value.size, sha256: sha256(new Uint8Array(await value.arrayBuffer())) });
  }
  return Response.json({ parts });
}

async function readBytes(response: Response) {
  if (!response.body) throw new Error("Response has no body");
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.byteLength;
  return bytes;
}

function makeBytes(size: number) {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to run e2e tests`);
  return value;
}
