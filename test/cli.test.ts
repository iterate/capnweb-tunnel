import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createRouterClient } from "@orpc/server";
import { expect, test } from "vitest";

import { createCaptunCliRouter } from "../src/cli/bin.js";
import { isCaptunHealthRequest } from "../src/cli/tunnel-health.js";
import { CaptunTunnelConnectError } from "../src/index.js";

test("CLI tunnel connect errors do not blame DNS for active token conflicts", async () => {
  await using target = await createTestServer(defaultTargetHandler);

  const router = createCaptunCliRouter({
    readConfig: async () => undefined,
    createTunnel: async () => {
      throw new CaptunTunnelConnectError(
        "WebSocket connection failed: 409 Conflict: Tunnel name is already connected",
        { status: 409, statusText: "Conflict", body: "Tunnel name is already connected" },
      );
    },
  });
  const client = createRouterClient(router);

  let caught: unknown;
  try {
    await client.tunnel({
      target: String(target.port),
      gateway: "https://captun.sh",
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

test("CLI tunnel connect errors keep DNS guidance for unrelated 409 responses", async () => {
  await using target = await createTestServer(defaultTargetHandler);

  const router = createCaptunCliRouter({
    readConfig: async () => undefined,
    createTunnel: async () => {
      throw new CaptunTunnelConnectError(
        "WebSocket connection failed: 409 Conflict: Some other conflict",
        {
          status: 409,
          statusText: "Conflict",
          body: "Some other conflict",
        },
      );
    },
  });
  const client = createRouterClient(router);

  let caught: unknown;
  try {
    await client.tunnel({
      target: String(target.port),
      gateway: "https://custom.example.com",
      name: "demo",
      requestLogs: false,
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    message: expect.stringContaining("Some other conflict"),
  });
  expect(caught).toMatchObject({
    message: expect.stringContaining("DNS for"),
  });
});

test("CLI tunnel retries reuse the same generated hosted token", async () => {
  await using target = await createTestServer(defaultTargetHandler);
  const tokens: Array<string | undefined> = [];

  const router = createCaptunCliRouter({
    readConfig: async () => undefined,
    waitForShutdown: async () => {},
    tunnelRetries: 1,
    createTunnel: async (options) => {
      tokens.push(options.token);
      if (tokens.length === 1) throw new Error("try again");
      return {
        url: target.origin,
        token: options.token,
        [Symbol.dispose]() {},
      };
    },
  });
  const client = createRouterClient(router);

  await client.tunnel({
    target: String(target.port),
    gateway: "https://captun.sh",
    name: "demo",
    requestLogs: false,
  });

  expect(tokens).toEqual([tokens[0], tokens[0]]);
  expect(tokens[0]).toMatch(/^[a-f0-9]{32}$/);
});

function defaultTargetHandler(request: IncomingMessage, response: ServerResponse) {
  const req = new Request(`http://127.0.0.1${request.url || "/"}`);
  if (isCaptunHealthRequest(req)) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  response.end("ok\n");
}

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
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
