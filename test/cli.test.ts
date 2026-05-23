import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createRouterClient } from "@orpc/server";
import { expect, test } from "vitest";

import { createCaptunCliRouter } from "../src/cli/bin.js";

test("CLI tunnel connect errors do not blame DNS for active-owner conflicts", async () => {
  await using target = await createTestServer((_request, response) => {
    response.end("ok\n");
  });
  await using rejection = await createRejectedTunnelServer("Tunnel name is already connected\n");

  const router = createCaptunCliRouter({ readConfig: async () => undefined });
  const client = createRouterClient(router);

  let caught: unknown;
  try {
    await client.tunnel({
      target: String(target.port),
      serverUrl: rejection.origin,
      name: "demo",
      requestLogs: false,
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    message: expect.stringContaining("Tunnel name is already connected"),
  });
  expect(caught).not.toMatchObject({
    message: expect.stringContaining("DNS for"),
  });
});

async function createTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.stack : String(error));
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test-server port.");
  }
  return {
    port: address.port,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function createRejectedTunnelServer(body: string) {
  const sockets = new Set<{ destroy: () => void }>();
  const server = createServer((_request, response) => {
    response.writeHead(409, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  });
  server.on("upgrade", (_request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.write(
      [
        "HTTP/1.1 409 Conflict",
        "Content-Type: text/plain; charset=utf-8",
        "Cache-Control: no-store",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    );
    socket.destroy();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start test server");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
