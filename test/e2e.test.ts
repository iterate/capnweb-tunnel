import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";

import { createCaptunTunnel } from "../src/client.ts";
import { createCaptunWorkerFixture } from "./fixtures/captun-worker.ts";

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
  expect(response.status).toBe(200);

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
  expect(done.done).toBe(true);
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

async function createTunnelFixture(
  testName: string,
  fetch: (request: Request) => Response | Promise<Response>,
) {
  const server = await createServerFixture();
  const name = tunnelName(testName);
  try {
    const url = tunnelUrl(server.url, name);
    const tunnel = await createCaptunTunnel({
      url: new URL("__connect", url),
      headers: server.headers,
      fetch,
    });
    return {
      url: url.toString(),
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
  if (process.env.CAPTUN_SERVER_URL) {
    return {
      url: process.env.CAPTUN_SERVER_URL,
      headers: process.env.CAPTUN_SECRET
        ? { authorization: `Bearer ${process.env.CAPTUN_SECRET}` }
        : undefined,
      async [Symbol.asyncDispose]() {},
    };
  }

  const worker = await createCaptunWorkerFixture();
  return {
    url: worker.origin,
    headers: undefined,
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

function tunnelUrl(serverUrl: string, name: string) {
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
