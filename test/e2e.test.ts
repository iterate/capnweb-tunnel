import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";

import { createCaptunTunnel } from "../src/client.ts";

vi.setConfig({ testTimeout: 15_000 });

const captunServerUrl = process.env.CAPTUN_SERVER_URL;
if (!captunServerUrl) throw new Error("CAPTUN_SERVER_URL is required to load this e2e test module");
const serverUrl = captunServerUrl;

test.concurrent("forwards HTTP", async ({ task }) => {
  using tunnel = await createTunnelFixture(task.name, async (request) =>
    Response.json({ body: await request.text() }),
  );

  const response = await fetch(tunnel.url, {
    method: "POST",
    body: "hello through tunnel",
  });
  expect(await response.json()).toMatchObject({ body: "hello through tunnel" });
});

test.concurrent("streams a binary response", async ({ task }) => {
  using tunnel = await createTunnelFixture(task.name, () => {
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
  expect(response.status).toBe(200);

  if (!response.body) throw new Error("Response has no body");
  let bytes = 0;
  for await (const chunk of response.body) bytes += chunk.byteLength;
  expect(bytes).toBe(524_288);
});

test.concurrent("streams SSE events", async ({ task }) => {
  using tunnel = await createTunnelFixture(task.name, () => {
    const array = Array.from({ length: 5 }, (_, i) => `event: tunnel\nid: ${i + 1}\ndata: ${i + 1}\n\n`)
    return new Response(
      array.join("",),
      {headers: { "content-type": "text/event-stream; charset=utf-8" }},
    );
  });

  const response = await fetch(tunnel.url);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect((await response.text()).match(/^event: tunnel$/gm)).toHaveLength(5);
});

test.concurrent("uploads a raw file body", async ({ task }) => {
  using tunnel = await createTunnelFixture(task.name, async (request) => {
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
  using tunnel = await createTunnelFixture(task.name, async (request) => {
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

async function createTunnelFixture(
  testName: string,
  fetch: (request: Request) => Response | Promise<Response>,
) {
  const name = tunnelName(testName);
  const url = tunnelUrl(name);
  const tunnel = await createCaptunTunnel({
    url: new URL("__connect", url),
    headers: process.env.CAPTUN_SECRET
      ? { authorization: `Bearer ${process.env.CAPTUN_SECRET}` }
      : undefined,
    fetch,
  });
  return {
    url: url.toString(),
    [Symbol.dispose]: () => tunnel[Symbol.dispose](),
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

function makeBytes(size: number) {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
