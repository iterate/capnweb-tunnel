import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createCaptunTunnel } from "../src/client.js";

// Stress the expensive path: many named tunnels, each returning a large streamed
// binary response through Captun. This measures aggregate tunnel throughput,
// not just connection establishment.

type Measurement = {
  index: number;
  ok: boolean;
  mode?: string;
  connectMs?: number;
  responseMs?: number;
  readMs?: number;
  fetchMs?: number;
  totalMs?: number;
  clientCpuMs?: number;
  clientEventLoopUtilization?: number;
  bytes?: number;
  error?: string;
};

type Result = {
  count: number;
  successes: number;
  failures: number;
  p50?: number;
  p90?: number;
  p99?: number;
  measurements: Measurement[];
};

const counts = (process.env.COUNTS ?? "1,10,25,50,100")
  .split(",")
  .map((value) => Number(value.trim()));
const serverUrl = process.env.CAPTUN_SERVER_URL ?? "https://captun.example.workers.dev";
const out = process.env.OUT ?? "docs/performance/captun-streams.json";
const bytes = Number(process.env.BYTES ?? 2 * 1024 * 1024);
const chunkBytes = Number(process.env.CHUNK_BYTES ?? 64 * 1024);
const modes = (process.env.MODES ?? "stream")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const readMode = process.env.READ_MODE ?? "stream";
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 60_000);
const namePrefix = process.env.NAME_PREFIX ?? `stream-${randomBytes(4).toString("hex")}`;
const warmupCount = Number(process.env.WARMUP_COUNT ?? 0);
const connectConcurrency = Number(process.env.CONNECT_CONCURRENCY ?? 0);

// Optional warmup opens and closes one tunnel per generated name. For high shard
// counts this wakes the shard Durable Objects before the timed stream test, so
// the result reflects streaming throughput rather than first-DO startup.
//
// READ_MODE=stream keeps the benchmark close to real proxy usage. READ_MODE=buffer
// uses Response.arrayBuffer() to check whether the Node-side HTTP body reader is
// the bottleneck.
if (warmupCount > 0) {
  console.log(`warming ${warmupCount} tunnels`);
  await runPool(
    warmupCount,
    Math.min(warmupCount, Math.max(connectConcurrency, 25)),
    async (index) => {
      const session = await createCaptunTunnel({
        url: `${tunnelUrl(`${namePrefix}-warm-${index}`)}/__captun-connect`,
        headers: captunHeaders(),
        fetch: () => testResponse("stream"),
      });
      session[Symbol.dispose]();
    },
  );
}

const results: Result[] = [];
for (const count of counts) {
  for (const mode of modes) {
    console.log(`benchmarking ${count} concurrent ${formatBytes(bytes)} ${mode} responses`);
    const result = await benchmark(count, mode);
    results.push(result);
    console.log(summary(result));
  }
}

await mkdir("docs/performance", { recursive: true });
await writeFile(
  out,
  `${JSON.stringify({ serverUrl, bytes, chunkBytes, modes, readMode, timeoutMs, results }, null, 2)}\n`,
);
console.log(`wrote ${out}`);

async function benchmark(count: number, mode: string): Promise<Result> {
  // By default, all tunnels connect and fetch at once. CONNECT_CONCURRENCY lets
  // us avoid measuring a burst of WebSocket handshakes when the question is how
  // many already-established tunnels can stream concurrently.
  const concurrency = connectConcurrency > 0 ? connectConcurrency : count;
  const measurements = await runPool(count, concurrency, (index) => measure(index, mode));
  const values = measurements.flatMap((measurement) =>
    measurement.ok && measurement.totalMs ? [measurement.totalMs] : [],
  );
  values.sort((a, b) => a - b);
  return {
    count,
    successes: values.length,
    failures: measurements.length - values.length,
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p99: quantile(values, 0.99),
    measurements,
  };
}

async function runPool<T>(count: number, concurrency: number, task: (index: number) => Promise<T>) {
  const results: T[] = Array.from({ length: count });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next < count) {
        const index = next++;
        results[index] = await task(index);
      }
    }),
  );
  return results;
}

async function measure(index: number, mode: string): Promise<Measurement> {
  // Deterministic names make runs reproducible and let us intentionally spread
  // or collide names across shards by changing NAME_PREFIX and CAPTUN_SHARDS.
  const url = tunnelUrl(`${namePrefix}-${index}`);
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const eventLoopStarted = performance.eventLoopUtilization();
  let tunnel: Disposable | undefined;
  try {
    tunnel = await createCaptunTunnel({
      url: `${url}/__captun-connect`,
      headers: captunHeaders(),
      fetch: () => testResponse(mode),
    });
    const connectedAt = performance.now();
    const response = await withTimeout(fetch(url), timeoutMs, "fetch timed out");
    const responseAt = performance.now();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const received = await readBytes(response);
    if (received !== bytes) throw new Error(`expected ${bytes} bytes, got ${received}`);
    const fetchedAt = performance.now();
    const cpu = process.cpuUsage(cpuStarted);
    const eventLoop = performance.eventLoopUtilization(eventLoopStarted);
    return {
      index,
      ok: true,
      mode,
      connectMs: connectedAt - started,
      responseMs: responseAt - connectedAt,
      readMs: fetchedAt - responseAt,
      fetchMs: fetchedAt - connectedAt,
      totalMs: fetchedAt - started,
      clientCpuMs: (cpu.user + cpu.system) / 1000,
      clientEventLoopUtilization: eventLoop.utilization,
      bytes: received,
    };
  } catch (error) {
    return {
      index,
      ok: false,
      mode,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    tunnel?.[Symbol.dispose]();
  }
}

function captunHeaders() {
  return process.env.CAPTUN_SECRET
    ? { authorization: `Bearer ${process.env.CAPTUN_SECRET}` }
    : undefined;
}

function testResponse(mode: string) {
  if (mode === "bytes") {
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/octet-stream" },
    });
  }
  if (mode === "text") {
    return new Response("x".repeat(bytes), {
      headers: { "content-type": "text/plain" },
    });
  }
  return streamResponse();
}

function streamResponse() {
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent >= bytes) return controller.close();
        const size = Math.min(chunkBytes, bytes - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size));
      },
    }),
    {
      headers: { "content-type": "application/octet-stream" },
    },
  );
}

async function readBytes(response: Response) {
  if (readMode === "buffer") return (await response.arrayBuffer()).byteLength;
  let total = 0;
  for await (const chunk of response.body ?? []) total += chunk.byteLength;
  return total;
}

function tunnelUrl(name: string) {
  if (serverUrl.includes("{name}")) return serverUrl.replaceAll("{name}", name).replace(/\/$/, "");
  const url = new URL(serverUrl);
  if (url.hostname.match(/^[^.]+\.tunnels\./)) url.pathname = "/";
  else url.pathname = `/${name}`;
  return url.toString().replace(/\/$/, "");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function quantile(values: number[], q: number) {
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
}

function summary(result: Result) {
  return `ok=${result.successes}/${result.count} p50=${ms(result.p50)} p90=${ms(result.p90)} p99=${ms(result.p99)}`;
}

function ms(value: number | undefined) {
  return value === undefined ? "n/a" : `${Math.round(value)}ms`;
}

function formatBytes(value: number) {
  return `${Math.round(value / 1024 / 1024)}MiB`;
}
