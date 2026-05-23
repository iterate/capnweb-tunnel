import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createRouterClient } from "@orpc/server";
import { expect, test } from "vitest";

import { createCaptunTunnel } from "../src/index.js";
import { createCaptunCliRouter } from "../src/cli/bin.js";

const publicHostedTest = process.env.CAPTUN_PUBLIC_E2E === "1" ? test : test.skip;

publicHostedTest(
  "createCaptunTunnel({ fetch }) registers a public captun.sh tunnel",
  async () => {
    const reached = Promise.withResolvers<{ path: string; body: string }>();

    await using tunnel = await createCaptunTunnel({
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.text();
        reached.resolve({ path: url.pathname, body });
        return Response.json({ path: url.pathname, body });
      },
    });

    expect(tunnel.url).toMatch(/^https:\/\/[a-z0-9-]+\.captun\.sh$/);

    const response = await fetch(`${tunnel.url}/library-api`, {
      method: "POST",
      body: "hello from vitest",
    });

    expect(await response.json()).toMatchObject({
      path: "/library-api",
      body: "hello from vitest",
    });
    await expect(reached.promise).resolves.toMatchObject({
      path: "/library-api",
      body: "hello from vitest",
    });
  },
  15_000,
);

publicHostedTest("CLI router tunnels a local test server through captun.sh", async () => {
  const reached = Promise.withResolvers<{ path: string; body: string }>();
  await using server = await createTestServer(async (req, res) => {
    const body = await readBody(req);
    const path = req.url || "/";
    reached.resolve({ path, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path, body }));
  });

  const shutdown = Promise.withResolvers<void>();
  const router = createCaptunCliRouter({
    readConfig: async () => undefined,
    waitForShutdown: () => shutdown.promise,
    onTunnelReady: async ({ url }) => {
      const response = await fetch(`${url}/cli-router`, {
        method: "POST",
        body: "hello from local server",
      });
      expect(await response.json()).toMatchObject({
        path: "/cli-router",
        body: "hello from local server",
      });
      shutdown.resolve();
    },
  });
  const client = createRouterClient(router);

  await client.tunnel({ target: String(server.port), requestLogs: false });

  await expect(reached.promise).resolves.toMatchObject({
    path: "/cli-router",
    body: "hello from local server",
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

async function readBody(req: IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}
