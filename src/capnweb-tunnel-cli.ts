#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as prompts from "@inquirer/prompts";
import { os } from "@orpc/server";
import { createCli } from "trpc-cli";
import { z } from "zod/v4";
import { createCaptunTunnel } from "./client.ts";
import type { Fetcher } from "./types.ts";

type Config = {
  serverUrl: string;
  secret?: string;
};

const adjectives = "apple amber bright cedar copper daisy ember forest ginger harbor indigo jolly kiwi lemon maple nova olive pearl quartz ruby".split(" ");
const speeds = "fast swift quick rapid zippy brisk fleet nimble snappy speedy lively eager sharp ready active bold crisp fresh keen spry".split(" ");
const things = "tree river stone cloud field bridge spark meadow tower trail garden island planet signal anchor valley window canyon summit harvest".split(" ");

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(homedir(), ".capnweb-tunnel.json");

const router = os.router({
  tunnel: os
    .meta({
      default: true,
      description: "Expose a local HTTP server through your Capnweb tunnel Worker.",
      examples: ["capnweb-tunnel 3000", "capnweb-tunnel 5173 --name my-app"],
    })
    .input(
      z.object({
        port: z.coerce
          .number()
          .int()
          .positive()
          .default(3000)
          .meta({ positional: true })
          .describe("Local port to expose"),
        name: z.string().optional().describe("Tunnel name"),
        serverUrl: z.url().optional().describe("Tunnel Worker base URL"),
        secret: z.string().optional().describe("Tunnel connection secret"),
      }),
    )
    .handler(async ({ input }) => {
      const config = await readConfig();
      const serverUrl =
        input.serverUrl ?? process.env.CAPTUN_SERVER_URL ?? process.env.TUNNEL_SERVER_URL ?? config?.serverUrl;
      if (!serverUrl) {
        throw new Error(`No tunnel server configured. Run "capnweb-tunnel deploy" first or pass --server-url.`);
      }

      const secret = input.secret ?? process.env.CAPTUN_SECRET ?? process.env.TUNNEL_SECRET ?? config?.secret;
      const name = input.name ?? randomName();
      const tunnel = tunnelUrl(serverUrl, name);
      const origin = `http://127.0.0.1:${input.port}`;

      const tunnelSession = await createCaptunTunnel({
        url: new URL("__connect", tunnel),
        headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
        fetch: ((request) => {
          const url = new URL(request.url);
          return fetch(new Request(new URL(url.pathname + url.search, origin), request));
        }) satisfies Fetcher["fetch"],
      });

      console.log(`tunneling ${tunnel} -> ${origin}`);
      try {
        await waitForShutdown();
      } finally {
        tunnelSession[Symbol.dispose]();
      }
    }),

  deploy: os
    .meta({
      description: "Deploy the Capnweb tunnel Worker with Wrangler and save local CLI config.",
      prompt: true,
      examples: ["capnweb-tunnel deploy", "capnweb-tunnel deploy --route '*.tunnels.example.com/*'"],
    })
    .input(
      z.object({
        route: z.string().optional().describe("Optional Worker route, for example *.tunnels.example.com/*"),
        secret: z
          .string()
          .default(() => randomSecret())
          .describe("Secret required by tunnel clients"),
      }),
    )
    .handler(async ({ input }) => {
      const serverUrl = await deployWorker(input);
      await writeConfig({ serverUrl, secret: input.secret });
      return { serverUrl, configPath };
    }),
});

const cli = createCli({
  router,
  name: "capnweb-tunnel",
  version: "0.0.0",
  description: "Expose local HTTP servers through a tiny Cloudflare Worker tunnel.",
});

await cli.run({ prompts });

async function deployWorker(input: { route?: string; secret: string }) {
  const tempDir = await mkdtemp(resolve(tmpdir(), "capnweb-tunnel-"));
  const secretsFile = resolve(tempDir, "secrets.json");
  try {
    await writeFile(secretsFile, JSON.stringify({ CAPTUN_SECRET: input.secret }), { mode: 0o600 });

    const config = resolve(packageRoot, "wrangler.toml");
    const worker = resolve(packageRoot, "dist/worker.js");
    const args = [
      "--cwd",
      packageRoot,
      "deploy",
      worker,
      "--config",
      config,
      "--secrets-file",
      secretsFile,
      "--keep-vars",
    ];
    if (input.route) args.push("--route", input.route);

    const output = await runWrangler(args);
    const serverUrl = input.route ? serverUrlFromRoute(input.route) : serverUrlFromWranglerOutput(output);
    if (!serverUrl) {
      throw new Error("Wrangler deploy succeeded, but the Worker URL was not found in its output.");
    }
    return serverUrl;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function runWrangler(args: string[]) {
  const wranglerBin = require.resolve("wrangler/bin/wrangler.js");
  const child = spawn(process.execPath, [wranglerBin, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk;
    process.stderr.write(chunk);
  });

  return new Promise<string>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`wrangler deploy failed with exit code ${code ?? "unknown"}`));
    });
  });
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as Config;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeConfig(config: Config) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function tunnelUrl(baseUrl: string, name: string) {
  if (baseUrl.includes("{name}")) return ensureTrailingSlash(baseUrl.replaceAll("{name}", name));

  const url = new URL(baseUrl);
  if (url.hostname.match(/^[^.]+\.tunnels\./)) {
    url.pathname = "/";
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(name)}/`;
  }
  return url.toString();
}

function serverUrlFromRoute(route: string) {
  const withoutProtocol = route.replace(/^https?:\/\//, "");
  const [hostPart, ...pathParts] = withoutProtocol.split("/");
  const host = hostPart?.startsWith("*.") ? `{name}.${hostPart.slice(2)}` : hostPart;
  if (!host) throw new Error(`Cannot infer server URL from route: ${route}`);

  const path = pathParts.join("/").replace(/\*.*$/, "").replace(/\/$/, "");
  return `https://${host}${path ? `/${path}` : ""}`;
}

function serverUrlFromWranglerOutput(output: string) {
  return output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/)?.[0];
}

function ensureTrailingSlash(url: string) {
  return url.endsWith("/") ? url : `${url}/`;
}

function waitForShutdown() {
  return new Promise<void>((resolvePromise) => {
    const done = () => resolvePromise();
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function randomName() {
  return [pick(adjectives), pick(speeds), pick(things)].join("-");
}

function pick(words: string[]) {
  const word = words[Math.floor(Math.random() * words.length)];
  if (!word) throw new Error("Cannot pick from an empty word list");
  return word;
}
