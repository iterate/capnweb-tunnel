import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { expect, test, vi } from "vitest";

import { createCaptunTunnel } from "../../src/client.ts";

vi.setConfig({ testTimeout: 30_000 });

test("returns nicely formatted weather report", async () => {
  await using app = await createWeatherReporterFixture();
  using _tunnel = await createCaptunTunnel({
    url: `${app.url}/__intercept-egress-traffic`,
    fetch(request) {
      if (request.url === "https://wttr.in/london?format=j1") {
        return Response.json({ current_condition: [{ temp_C: "18" }] });
      }
      if (request.url === "https://wttr.in/new+york?format=j1") {
        return Response.json({ current_condition: [{ temp_C: "22" }] });
      }
      return new Response("Unexpected egress", { status: 500 });
    },
  });

  const london = await fetch(`${app.url}/weather/london`);
  expect(await london.text()).toBe("The temperature in london is 18 celsius");

  const newYork = await fetch(`${app.url}/weather/new+york`);
  expect(await newYork.text()).toBe("The temperature in new+york is 22 celsius");
});

async function createWeatherReporterFixture() {
  if (process.env.WEATHER_REPORTER_URL) {
    return {
      url: process.env.WEATHER_REPORTER_URL,
      async [Symbol.asyncDispose]() {},
    };
  }

  const port = await getAvailablePort();
  const inspectorPort = await getAvailablePort();
  const persistTo = await mkdtemp(join(tmpdir(), "captun-weather-reporter-"));
  const aborter = new AbortController();
  const wrangler = x(
    "wrangler",
    [
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      persistTo,
      "--show-interactive-dev-session=false",
      "--log-level",
      "warn",
    ],
    {
      signal: aborter.signal,
      nodeOptions: {
        cwd: dirname(fileURLToPath(import.meta.url)),
        env: { ...process.env, NO_COLOR: "1" },
      },
    },
  );
  const wranglerResult: WranglerDevResult = Promise.resolve(wrangler).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForWranglerDev(url, wrangler, wranglerResult);
  } catch (error) {
    await stopWranglerDev(wrangler, aborter, wranglerResult);
    await rm(persistTo, { recursive: true, force: true });
    throw error;
  }

  return {
    url,
    async [Symbol.asyncDispose]() {
      await stopWranglerDev(wrangler, aborter, wranglerResult);
      await rm(persistTo, { recursive: true, force: true });
    },
  };
}

type WranglerDevProcess = ReturnType<typeof x>;
type WranglerDevOutput = Awaited<WranglerDevProcess>;
type WranglerDevResult = Promise<WranglerDevOutput | Error>;

async function waitForWranglerDev(url: string, wrangler: WranglerDevProcess, wranglerResult: WranglerDevResult) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const startupError = getWranglerExit(wrangler);
    if (startupError) {
      throw new Error(`wrangler dev failed to start\n\n${formatWranglerResult(await wranglerResult)}`, {
        cause: startupError,
      });
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      return;
    } catch {
      await setTimeout(100);
    }
  }
  throw new Error(`Timed out waiting for wrangler dev at ${url}`);
}

async function stopWranglerDev(wrangler: WranglerDevProcess, aborter: AbortController, wranglerResult: WranglerDevResult) {
  if (getWranglerExit(wrangler)) {
    await wranglerResult;
    return;
  }

  aborter.abort();
  wrangler.kill("SIGTERM");
  const exited = await Promise.race([
    wranglerResult.then(() => true),
    setTimeout(5_000).then(() => false),
  ]);
  if (!exited) {
    wrangler.kill("SIGKILL");
    await wranglerResult;
  }
}

function formatWranglerResult(result: WranglerDevOutput | Error) {
  if (result instanceof Error) return result.stack || result.message;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (output) return output;
  return `wrangler dev exited with code ${result.exitCode || "none"}`;
}

function getWranglerExit(wrangler: WranglerDevProcess) {
  if (!wrangler.process) {
    return new Error("wrangler dev did not start");
  }
  if (wrangler.process.exitCode !== null || wrangler.process.signalCode !== null) {
    return new Error(
      `wrangler dev exited with code ${wrangler.process.exitCode || "none"} and signal ${wrangler.process.signalCode || "none"}`,
    );
  }
}

function getAvailablePort() {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Expected an IPv4 port from the test server"));
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
  return promise;
}
