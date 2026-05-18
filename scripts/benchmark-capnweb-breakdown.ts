import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { CapnwebTunnelClient } from "../src/client.ts";

type Measurement = {
  index: number;
  connectMs: number;
  callbackMs: number;
  originFetchMs: number;
  publicFetchMs: number;
  totalMs: number;
};

const samples = Number(process.env.SAMPLES ?? 20);
const capnwebUrl = process.env.CAPNWEB_URL ?? "https://{name}.tunnels.templestein.com";
const out = process.env.OUT ?? "docs/performance/capnweb-breakdown.json";

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
  const measurements: Measurement[] = [];

  for (let index = 0; index < samples; index++) {
    const measurement = await measure(index, originUrl);
    measurements.push(measurement);
    console.log(
      `sample ${index + 1}/${samples}: connect=${ms(measurement.connectMs)} callback=${ms(measurement.callbackMs)} origin=${ms(measurement.originFetchMs)} public=${ms(measurement.publicFetchMs)} total=${ms(measurement.totalMs)}`,
    );
  }

  await mkdir("docs/performance", { recursive: true });
  await writeFile(out, `${JSON.stringify({ originUrl, capnwebUrl, measurements, summary: summarize(measurements) }, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  origin.close();
}

async function measure(index: number, originUrl: string): Promise<Measurement> {
  const name = `breakdown-${randomBytes(8).toString("hex")}`;
  const url = tunnelUrl(capnwebUrl, name);
  let callbackAt = 0;
  let originDoneAt = 0;

  const started = performance.now();
  const client = new CapnwebTunnelClient(url, {
    secret: process.env.TUNNEL_SECRET,
    fetch: async (request) => {
      callbackAt = performance.now();
      const incoming = new URL(request.url);
      const response = await fetch(new URL(incoming.pathname + incoming.search, originUrl), request);
      originDoneAt = performance.now();
      return response;
    },
  });

  try {
    await client.connect();
    const connectedAt = performance.now();
    const response = await fetch(url);
    if (!response.ok || !(await response.text()).startsWith("ok")) {
      throw new Error(`first fetch failed: HTTP ${response.status}`);
    }
    const fetchedAt = performance.now();
    return {
      index,
      connectMs: connectedAt - started,
      callbackMs: callbackAt - connectedAt,
      originFetchMs: originDoneAt - callbackAt,
      publicFetchMs: fetchedAt - connectedAt,
      totalMs: fetchedAt - started,
    };
  } finally {
    client.close();
  }
}

function tunnelUrl(base: string, name: string) {
  if (base.includes("{name}")) return new URL(base.replaceAll("{name}", name));
  const url = new URL(base);
  url.pathname = `/${name}/`;
  return url;
}

function summarize(measurements: Measurement[]) {
  return {
    connectMs: percentile(measurements.map((measurement) => measurement.connectMs), 0.5),
    callbackMs: percentile(measurements.map((measurement) => measurement.callbackMs), 0.5),
    originFetchMs: percentile(measurements.map((measurement) => measurement.originFetchMs), 0.5),
    publicFetchMs: percentile(measurements.map((measurement) => measurement.publicFetchMs), 0.5),
    totalMs: percentile(measurements.map((measurement) => measurement.totalMs), 0.5),
  };
}

function percentile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
}

function ms(value: number) {
  return `${Math.round(value)}ms`;
}
