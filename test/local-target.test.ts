import { createServer, type Server } from "node:net";
import { expect, test } from "vitest";

import { assertLocalTargetAcceptingConnections } from "../src/cli/local-target.js";

test("local target preflight passes when the port accepts TCP connections", async () => {
  await using listening = await listenOnRandomPort();

  await assertLocalTargetAcceptingConnections(`http://127.0.0.1:${listening.port}`, {
    timeoutMs: 100,
  });

  expect(listening).toMatchObject({ server: { listening: true } });
});

test("local target preflight fails when the port is closed", async () => {
  const { port } = await (async () => {
    await using temp = await listenOnRandomPort();
    return { port: temp.port };
  })();

  await expect(
    assertLocalTargetAcceptingConnections(`http://127.0.0.1:${port}`, { timeoutMs: 100 }),
  ).rejects.toThrow(`http://127.0.0.1:${port} is not accepting connections`);
});

async function listenOnRandomPort(): Promise<{
  server: Server;
  port: number;
  [Symbol.asyncDispose](): Promise<void>;
}> {
  const server = createServer((socket) => socket.end());

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      resolve(address.port);
    });
  });

  return {
    server,
    port,
    async [Symbol.asyncDispose]() {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
