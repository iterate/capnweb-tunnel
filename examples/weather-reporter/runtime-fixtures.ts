import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

export type WeatherReporterRuntime = "bun" | "deno" | "node";

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(exampleRoot, "../..");
type WeatherReporterProcess = ChildProcessByStdio<null, Readable, Readable>;

export async function createRuntimeWeatherReporterFixture(runtime: WeatherReporterRuntime) {
  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const server = startWeatherReporterProcess(runtime, port);
  const output = captureOutput(server);

  try {
    await waitForHttp(`${url}/__health__`, 15_000, server, output);
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

function startWeatherReporterProcess(runtime: WeatherReporterRuntime, port: number) {
  const commands: Record<WeatherReporterRuntime, { command: string; args: string[] }> = {
    bun: { command: "bun", args: ["run", "examples/weather-reporter/bun.ts"] },
    deno: {
      command: "deno",
      args: [
        "run",
        "--config",
        "examples/weather-reporter/deno.json",
        "--node-modules-dir=auto",
        "--no-lock",
        "--sloppy-imports",
        "--allow-env=PORT",
        "--allow-net=127.0.0.1",
        "examples/weather-reporter/deno.ts",
      ],
    },
    node: { command: "pnpm", args: ["exec", "tsx", "examples/weather-reporter/node.ts"] },
  };
  const command = commands[runtime];
  return spawn(command.command, command.args, {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  server: WeatherReporterProcess,
  output: CapturedProcessOutput,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const error = output.error();
    if (error) throw error;

    if (server.exitCode !== null || server.signalCode) {
      throw new Error(
        `Weather reporter process exited before ${url} responded\n\n${output.logs().trim() || "(none)"}`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}

    await delay(100);
  }

  throw new Error(`Timed out waiting for weather reporter to respond at ${url}`);
}

function captureOutput(child: WeatherReporterProcess) {
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

function formatFixtureFailure(message: string, serverLogs: string): string {
  return [message, "", "Server logs:", serverLogs.trim() || "(none)"].join("\n");
}

async function stopProcess(child: WeatherReporterProcess): Promise<void> {
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
