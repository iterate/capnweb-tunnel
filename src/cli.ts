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

const DEFAULT_SERVER_URL = "http://localhost:8787";

const adjectives = "apple amber bright cedar copper daisy ember forest ginger harbor indigo jolly kiwi lemon maple nova olive pearl quartz ruby".split(" ");
const speeds = "fast swift quick rapid zippy brisk fleet nimble snappy speedy lively eager sharp ready active bold crisp fresh keen spry".split(" ");
const things = "tree river stone cloud field bridge spark meadow tower trail garden island planet signal anchor valley window canyon summit harvest".split(" ");

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

const router = os.router({
  tunnel: os
    .meta({
      default: true,
      description: "Expose a local HTTP server through your Captun Worker.",
      examples: ["captun 3000", "captun 5173 --name my-app"],
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
        input.serverUrl ?? process.env.CAPTUN_SERVER_URL ?? config?.serverUrl ?? DEFAULT_SERVER_URL;

      const secret = input.secret ?? process.env.CAPTUN_SECRET ?? config?.secret;
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
      description: "Deploy the Captun Worker with Wrangler and save local CLI config.",
      examples: ["captun deploy", "captun deploy --route '*.tunnels.example.com/*'"],
    })
    .input(
      z.object({
        route: z
          .string()
          .optional()
          .describe("Custom Worker route (leave empty for *.workers.dev), e.g. *.tunnels.example.com/*"),
        zone: z
          .string()
          .optional()
          .describe("Cloudflare zone name for the route (e.g. templestein.com)"),
        secret: z
          .string()
          .default(() => randomSecret())
          .describe("Secret required by tunnel clients"),
        dryRun: z.boolean().optional().describe("Compile and validate the deploy without uploading"),
      }),
    )
    .handler(async ({ input }) => {
      if (input.dryRun) {
        await deployWorker(input);
        const serverUrl = input.route
          ? serverUrlFromRoute(input.route)
          : "https://captun.<your-account>.workers.dev";
        console.log(`\nDry run complete (no upload, config not written).`);
        console.log(`Expected server URL pattern: ${serverUrl}`);
        return { serverUrl, dryRun: true };
      }

      const serverUrl = await deployWorker(input);
      const path = captunConfigPath();
      await writeConfig({ serverUrl, secret: input.secret });
      console.log(`\nWrote ${path}`);
      console.log(`Server URL: ${serverUrl}`);
      console.log(`Secret (save this): ${input.secret}`);
      return { serverUrl, configPath: path };
    }),
});

const cli = createCli({
  router,
  name: "captun",
  version: packageJson.version,
  description: "Expose local HTTP servers through a tiny Cloudflare Worker tunnel.",
});

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
await cli.run(interactive ? { prompts } : {});

async function deployWorker(input: {
  route?: string;
  zone?: string;
  secret: string;
  dryRun?: boolean;
}) {
  const tempDir = await mkdtemp(resolve(tmpdir(), "captun-"));
  const secretsFile = resolve(tempDir, "secrets.json");
  try {
    await writeFile(secretsFile, JSON.stringify({ CAPTUN_SECRET: input.secret }), { mode: 0o600 });

    let config = resolve(packageRoot, "wrangler.toml");
    if (input.route && input.zone) {
      const base = await readFile(config, "utf8");
      const workerEntry = resolve(packageRoot, "src/worker.ts");
      const deployConfig = resolve(tempDir, "wrangler.toml");
      const withMain = base.replace(/^main\s*=\s*.+$/m, `main = ${JSON.stringify(workerEntry)}`);
      await writeFile(
        deployConfig,
        `${withMain.trimEnd()}\n\n[[routes]]\npattern = ${JSON.stringify(input.route)}\nzone_name = ${JSON.stringify(input.zone)}\n`,
      );
      config = deployConfig;
    }

    const args = [
      "--cwd",
      packageRoot,
      "deploy",
      "--config",
      config,
      "--secrets-file",
      secretsFile,
      "--keep-vars",
    ];
    if (input.route && !input.zone) args.push("--route", input.route);
    if (input.dryRun) args.push("--dry-run");

    const output = await runWrangler(args);
    if (input.dryRun) {
      return input.route ? serverUrlFromRoute(input.route) : "https://captun.<your-account>.workers.dev";
    }

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

function captunConfigPath() {
  const configHome = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME, "captun")
    : resolve(homedir(), ".config", "captun");
  return resolve(configHome, "config.json");
}

async function readConfig() {
  const path = captunConfigPath();
  try {
    return JSON.parse(await readFile(path, "utf8")) as Config;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeConfig(config: Config) {
  const path = captunConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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
