import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { expect, test, vi } from "vitest";

import { createCaptunTunnel } from "../../src/client.js";

vi.setConfig({ testTimeout: 20_000 });

test("returns nicely formatted weather report from a Node server", async () => {
  await using app = await createNodeWeatherReporterFixture();
  using _tunnel = await createCaptunTunnel({
    url: `${app.url}/__intercept-egress-traffic`,
    fetch(request) {
      if (request.url === "https://wttr.in/london?format=j1") {
        return Response.json({ current_condition: [{ temp_C: "18" }] });
      }
      if (request.url === "https://wttr.in/paris?format=j1") {
        return Response.json({ current_condition: [{ temp_C: "22" }] });
      }
      return new Response("Unexpected egress", { status: 500 });
    },
  });

  const london = await fetch(`${app.url}/weather?city=london`);
  expect(await london.text()).toBe("The temperature in london is 18 celsius");

  const paris = await fetch(`${app.url}/weather?city=paris`);
  expect(await paris.text()).toBe("The temperature in paris is 22 celsius");
});

async function createNodeWeatherReporterFixture() {
  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn("pnpm", ["exec", "tsx", "examples/node/server.ts"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = captureOutput(server);

  try {
    await waitForTcp(port, server, output);
    return {
      url,
      async [Symbol.asyncDispose]() {
        await stopProcess(server);
      },
    };
  } catch (error) {
    await stopProcess(server);
    throw new Error(formatFixtureFailure(error instanceof Error ? error.message : String(error), output.logs()));
  }
}

type ServerProcess = ChildProcessByStdio<null, Readable, Readable>;

async function getAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error(`Failed to allocate a local port: ${String(address)}`));
        return;
      }

      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForTcp(port: number, server: ServerProcess, output: CapturedProcessOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const error = output.error();
    if (error) throw error;
    if (server.exitCode !== null || server.signalCode) {
      throw new Error(`Node server exited before port ${port} accepted connections\n\n${output.logs().trim() || "(none)"}`);
    }

    if (await canConnect(port)) return;

    await delay(100);
  }

  throw new Error(`Timed out waiting for Node server to accept connections on port ${port}`);
}

async function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function captureOutput(child: ServerProcess) {
  const chunks: string[] = [];
  let processError: Error | undefined;
  const capture = (chunk: string | Buffer) => {
    chunks.push(String(chunk));
    if (chunks.length > 200) chunks.shift();
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", (error) => {
    processError = error;
    chunks.push(error.stack || error.message);
  });

  return {
    logs: () => chunks.join(""),
    error: () => processError,
  };
}

interface CapturedProcessOutput {
  logs(): string;
  error(): Error | undefined;
}

function formatFixtureFailure(message: string, serverLogs: string) {
  return [message, "", "Server logs:", serverLogs.trim() || "(none)"].join("\n");
}

async function stopProcess(child: ServerProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;

  child.kill("SIGINT");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(5_000).then(() => false),
  ]);

  if (!exited && child.exitCode === null && !child.killed) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
