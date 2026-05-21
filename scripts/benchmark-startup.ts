import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { createCaptunTunnel } from "../src/index.js";

// Measures time from "start creating a tunnel" to the first successful public
// HTTP fetch through that tunnel. It can compare this project with cloudflared
// quick tunnels and ngrok, but only Captun is intended for high-concurrency
// runs here.

type Provider = "captun" | "cloudflared" | "ngrok" | "wrangler-tunnel";

type Measurement = {
  index: number;
  ok: boolean;
  ms?: number;
  url?: string;
  error?: string;
};

type Result = {
  provider: Provider;
  count: number;
  successes: number;
  failures: number;
  p50?: number;
  p90?: number;
  p99?: number;
  measurements: Measurement[];
};

const providers = (process.env.PROVIDERS ?? "captun")
  .split(",")
  .map((value) => value.trim() as Provider);
const counts = (process.env.COUNTS ?? "1,10,100,500,1000,2000")
  .split(",")
  .map((value) => Number(value.trim()));
const captunUrl = process.env.CAPTUN_SERVER_URL ?? "https://{name}.tunnels.example.com";
const out =
  process.env.OUT ??
  `docs/performance/startup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 60_000);
const processOptions: SpawnOptions = {
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
};

const origin = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(`ok ${request.url}`);
});
origin.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => origin.once("listening", resolve));

try {
  const address = origin.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local origin");
  const originUrl = `http://127.0.0.1:${address.port}`;
  const results: Result[] = [];

  for (const provider of providers) {
    for (const count of counts) {
      console.log(`benchmarking ${provider} x ${count}`);
      const result = await benchmark(provider, count, originUrl);
      results.push(result);
      console.log(summary(result));
    }
  }

  await mkdir("docs/performance", { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ originUrl, captunUrl, timeoutMs, results }, null, 2)}\n`,
  );
  console.log(`wrote ${out}`);
} finally {
  origin.close();
}

async function benchmark(provider: Provider, count: number, originUrl: string): Promise<Result> {
  const measurements = await Promise.all(
    Array.from({ length: count }, (_, index) => measure(provider, index, originUrl)),
  );
  const values = measurements.flatMap((measurement) =>
    measurement.ok && measurement.ms ? [measurement.ms] : [],
  );
  values.sort((a, b) => a - b);
  return {
    provider,
    count,
    successes: values.length,
    failures: measurements.length - values.length,
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
    measurements,
  };
}

async function measure(provider: Provider, index: number, originUrl: string): Promise<Measurement> {
  try {
    if (provider === "captun") return await measureCaptun(index, originUrl);
    return await measureProcess(provider, index, originUrl);
  } catch (error) {
    return { index, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function measureCaptun(index: number, originUrl: string): Promise<Measurement> {
  const name = `bench-${randomBytes(8).toString("hex")}`;
  const url = tunnelUrl(captunUrl, name);
  const started = performance.now();
  let tunnel: Disposable | undefined;
  try {
    tunnel = await createCaptunTunnel({
      url: `${url}/__captun-connect`,
      headers: process.env.CAPTUN_SECRET
        ? { authorization: `Bearer ${process.env.CAPTUN_SECRET}` }
        : undefined,
      fetch: (request) => {
        const incoming = new URL(request.url);
        return fetch(`${originUrl}${incoming.pathname}${incoming.search}`, request);
      },
    });
    await waitForFetch(url, started);
    return { index, ok: true, ms: performance.now() - started, url };
  } finally {
    tunnel?.[Symbol.dispose]();
  }
}

async function measureProcess(
  provider: Exclude<Provider, "captun">,
  index: number,
  originUrl: string,
): Promise<Measurement> {
  const started = performance.now();
  const child = spawnProcess(provider, originUrl);
  let output = "";

  try {
    const url = await new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${provider} did not print a public URL`)),
        timeoutMs,
      );
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const parsed =
          provider === "ngrok" ? parseNgrokUrl(output) : parseCloudflareTunnelUrl(output);
        if (parsed) {
          clearTimeout(timer);
          resolve(parsed);
        }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`${provider} exited with ${code}: ${lastLines(output)}`));
      });
      child.on("error", reject);
    });

    if (provider === "cloudflared" || provider === "wrangler-tunnel") {
      await waitForDns(url, started);
    }
    await waitForFetch(url, started);
    return { index, ok: true, ms: performance.now() - started, url: url.toString() };
  } catch (error) {
    return {
      index,
      ok: false,
      error: `${error instanceof Error ? error.message : String(error)}${output ? `\n${lastLines(output)}` : ""}`,
    };
  } finally {
    stop(child);
  }
}

function spawnProcess(provider: Exclude<Provider, "captun">, originUrl: string): ChildProcess {
  if (provider === "cloudflared") {
    return spawn(
      "cloudflared",
      ["tunnel", "--url", originUrl, "--no-autoupdate", "--metrics", "localhost:0"],
      processOptions,
    );
  }
  if (provider === "wrangler-tunnel") {
    return spawn(
      "wrangler",
      ["tunnel", "quick-start", originUrl, "--log-level", "info"],
      processOptions,
    );
  }
  return spawn("ngrok", ["http", originUrl, "--log=stdout", "--log-format=json"], processOptions);
}

async function waitForDns(url: URL, started: number) {
  let lastError = "";
  while (performance.now() - started < timeoutMs) {
    try {
      if ((await resolve4(url.hostname)).length) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DNS timed out for ${url.hostname}: ${lastError}`);
}

async function waitForFetch(url: string | URL, started: number) {
  let lastError = "";
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok && (await response.text()).startsWith("ok")) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`first fetch timed out: ${lastError}`);
}

function tunnelUrl(base: string, name: string) {
  if (base.includes("{name}")) return base.replaceAll("{name}", name).replace(/\/$/, "");
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString().replace(/\/$/, "");
}

function parseCloudflareTunnelUrl(output: string) {
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? new URL(match[0]) : undefined;
}

function parseNgrokUrl(output: string) {
  for (const line of output.split("\n")) {
    try {
      const parsed = JSON.parse(line) as { msg?: string; url?: string };
      if (parsed.msg === "started tunnel" && parsed.url?.startsWith("https://"))
        return new URL(parsed.url);
    } catch {
      // skip non-JSON lines
    }
  }
  return undefined;
}

function quantile(values: number[], q: number) {
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
}

function summary(result: Result) {
  return `${result.provider} x ${result.count}: ok=${result.successes} failed=${result.failures} p50=${ms(result.p50)} p90=${ms(result.p90)} p99=${ms(result.p99)}`;
}

function ms(value: number | undefined) {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

function lastLines(value: string) {
  return value.split("\n").slice(-8).join("\n");
}

function stop(child: ChildProcess) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // meh
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // meh
      }
    }, 2_000).unref();
    return;
  }
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000).unref();
}
