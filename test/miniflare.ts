// This could move to a wrangler dev based flow someday if we need to test Wrangler's local runtime.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

export async function createMiniflareWorkerFixture(options: {
  entryPoint: `${string}.ts`;
  durableObjects: Record<string, { className: string }>;
  bindings: Record<string, string>;
}) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tempDir = await mkdtemp(join(tmpdir(), "captun-miniflare-"));
  await esbuild.build({
    entryPoints: [resolve(repoRoot, options.entryPoint)],
    outfile: join(tempDir, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    external: ["cloudflare:workers"],
  });

  const miniflare = new Miniflare({
    modules: true,
    rootPath: tempDir,
    modulesRoot: tempDir,
    scriptPath: "worker.js",
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-05-15",
    durableObjects: options.durableObjects,
    bindings: options.bindings,
  });
  const url = await miniflare.ready;
  const worker = (await miniflare.getWorker()) as unknown as WorkerFetcherLike;

  return {
    origin: url.origin,
    worker,
    async [Symbol.asyncDispose]() {
      await miniflare.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

export function createCaptunWorkerFixture(bindings: Record<string, string>) {
  return createMiniflareWorkerFixture({
    entryPoint: "src/worker.ts",
    durableObjects: {
      CaptunServerShard: { className: "CaptunServerShard" },
    },
    bindings,
  });
}

export interface WorkerFetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
