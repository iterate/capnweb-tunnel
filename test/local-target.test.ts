import { createServer } from "node:net";
import { afterEach, expect, test } from "vitest";

import { assertLocalTargetAcceptingConnections } from "../src/local-target.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

test("local target preflight passes when the port accepts TCP connections", async () => {
  const { server, port } = await listenOnRandomPort();

  await assertLocalTargetAcceptingConnections(`http://127.0.0.1:${port}`, { timeoutMs: 100 });

  expect(server.listening).toBe(true);
});

test("local target preflight fails when the port is closed", async () => {
  const { server, port } = await listenOnRandomPort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.pop();

  await expect(
    assertLocalTargetAcceptingConnections(`http://127.0.0.1:${port}`, { timeoutMs: 100 }),
  ).rejects.toThrow(`http://127.0.0.1:${port} is not accepting connections`);
});

function listenOnRandomPort() {
  const server = createServer((socket) => socket.end());
  servers.push(server);

  return new Promise<{ server: ReturnType<typeof createServer>; port: number }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      resolve({ server, port: address.port });
    });
  });
}
