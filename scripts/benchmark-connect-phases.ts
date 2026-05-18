import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";

// Break connection time into comparable baselines:
// - edge HTTP with no Durable Object
// - raw Worker -> Durable Object HTTP/WebSocket
// - minimal Capnweb useFetcher() over a Durable Object
// - the real app path
//
// This is the script that showed the original ~400ms was fresh DO startup, not
// Capnweb or bundle size.

type Measurement = {
  kind: string;
  index: number;
  ms: number;
  url: string;
};

type ServerApi = {
  useFetcher(fetcher?: unknown): void | Promise<void>;
};

class Fetcher extends RpcTarget {
  fetch() {
    return new Response("ok\n");
  }
}

const samples = Number(process.env.SAMPLES ?? 20);
const out = process.env.OUT ?? "docs/performance/connect-phases.json";
const rawBase = process.env.RAW_BASE ?? "https://capnweb-tunnel-bench-raw.templestein.workers.dev";
const capnwebBase = process.env.CAPNWEB_BASE ?? "https://capnweb-tunnel-bench-capnweb.templestein.workers.dev";
const appBase = process.env.APP_BASE ?? "https://capnweb-tunnel-folder.templestein.workers.dev";

const measurements: Measurement[] = [];

await run("edge-http", () => measureHttp(new URL("/edge", rawBase)));
await run("raw-do-http-fresh", () => measureHttp(new URL(`/${freshName()}`, rawBase)));
await run("raw-do-ws-fresh", () => measureRawWebSocket(new URL(`/${freshName()}`, rawBase)));
await run("raw-do-ws-warm", () => measureRawWebSocket(new URL("/warm", rawBase)));
await run("minimal-capnweb-useFetcher-fresh", () => measureCapnwebUseFetcher(new URL(`/${freshName()}`, capnwebBase)));
await run("minimal-capnweb-useFetcher-warm", () => measureCapnwebUseFetcher(new URL("/warm", capnwebBase)));
await run("app-raw-ws-fresh", () => measureRawWebSocket(new URL(`/${freshName()}/__connect`, appBase)));
await run("app-raw-ws-warm", () => measureRawWebSocket(new URL("/warm/__connect", appBase)));
await run("app-capnweb-useFetcher-fresh", () => measureCapnwebUseFetcher(new URL(`/${freshName()}`, appBase)));
await run("app-capnweb-useFetcher-warm", () => measureCapnwebUseFetcher(new URL("/warm", appBase)));

const summary = summarize(measurements);
await mkdir("docs/performance", { recursive: true });
await writeFile(out, `${JSON.stringify({ samples, rawBase, capnwebBase, appBase, summary, measurements }, null, 2)}\n`);
console.table(summary.map((row) => ({
  kind: row.kind,
  p50: Math.round(row.p50),
  p90: Math.round(row.p90),
  min: Math.round(row.min),
  max: Math.round(row.max),
})));
console.log(`wrote ${out}`);

async function run(kind: string, measure: (index: number) => Promise<{ ms: number; url: string }>) {
  for (let index = 0; index < samples; index++) {
    const result = await measure(index);
    measurements.push({ kind, index, ...result });
  }
}

async function measureHttp(url: URL) {
  const started = performance.now();
  const response = await fetch(url);
  await response.arrayBuffer();
  return { ms: performance.now() - started, url: url.toString() };
}

async function measureRawWebSocket(url: URL) {
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`timeout opening ${url}`)), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket failed for ${url}`));
    });
  });
  return { ms: performance.now() - started, url: url.toString() };
}

async function measureCapnwebUseFetcher(url: URL) {
  if (!url.pathname.endsWith("/__connect")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/__connect`;
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const started = performance.now();
  const server = newWebSocketRpcSession<ServerApi>(url.toString());
  try {
    await server.useFetcher(new Fetcher());
    return { ms: performance.now() - started, url: url.toString() };
  } finally {
    server[Symbol.dispose]();
  }
}

function summarize(rows: Measurement[]) {
  return [...new Set(rows.map((row) => row.kind))].map((kind) => {
    const values = rows.filter((row) => row.kind === kind).map((row) => row.ms).sort((a, b) => a - b);
    return {
      kind,
      min: values[0],
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      max: values.at(-1)!,
    };
  });
}

function percentile(values: number[], q: number) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
}

function freshName() {
  return `bench-${randomBytes(8).toString("hex")}`;
}
