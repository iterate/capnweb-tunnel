import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

export async function createCaptunWorkerFixture(bindings: Record<string, string> = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "captun-miniflare-"));
  await esbuild.build({
    entryPoints: ["src/worker.ts"],
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
    durableObjects: {
      CaptunServerShard: { className: "CaptunServerShard" },
    },
    bindings,
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

export interface WorkerFetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
