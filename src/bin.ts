#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as prompts from "@inquirer/prompts";
import { os } from "@orpc/server";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod/v4";
import { createCaptunTunnel } from "./client.js";
import { CommandNotFoundError, ExecError, exec } from "./exec.js";
import { publicTunnelUrl, serverUrlFromRoute, tunnelConnectUrl } from "./tunnel-addressing.js";

type Config = {
  serverUrl: string;
  secret?: string;
};

const adjectives = "apple amber bright cedar copper daisy ember forest ginger harbor indigo jolly kiwi lemon maple nova olive pearl quartz ruby".split(" ");
const speeds = "fast swift quick rapid zippy brisk fleet nimble snappy speedy lively eager sharp ready active bold crisp fresh keen spry".split(" ");
const things = "tree river stone cloud field bridge spark meadow tower trail garden island planet signal anchor valley window canyon summit harvest".split(" ");

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
const configPath = resolve(xdgConfigHome || resolve(homedir(), ".config"), "captun", "config.json");

const router = os.router({
  tunnel: os
    .meta({
      default: true,
      description: "Expose a local HTTP server through your Captun tunnel Worker.",
      examples: ["captun 3000", "captun 5173 --name my-app"],
    })
    .input(
      z.object({
        port: z
          .number()
          .int()
          .positive()
          .default(3000)
          .describe("Local port to expose")
          .meta({ positional: true }),
        name: z.string().optional().describe("Tunnel name"),
        serverUrl: z.url().optional().describe("Tunnel Worker base URL"),
        secret: z.string().optional().describe("Tunnel connection secret"),
      }),
    )
    .handler(async ({ input }) => {
      const config = await readConfig();
      const serverUrl = input.serverUrl || config?.serverUrl;
      if (!serverUrl) {
        throw new Error(
          `No tunnel server configured. Run "captun deploy" first or pass --server-url.`,
        );
      }

      const secret = input.secret || config?.secret;
      const name = input.name || randomName();
      const tunnel = publicTunnelUrl(serverUrl, name);
      const origin = `http://127.0.0.1:${input.port}`;

      using _tunnelSession = await createCaptunTunnel({
        url: tunnelConnectUrl(serverUrl, name),
        headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
        fetch: (request) => {
          const url = new URL(request.url);
          return fetch(new Request(`${origin}${url.pathname}${url.search}`, request));
        },
      });

      console.log(`tunneling ${tunnel} -> ${origin}`);
      await waitForShutdown();
    }),

  deploy: os
    .meta({
      description: "Deploy the Captun tunnel Worker with Wrangler and save local CLI config.",
      prompt: false,
      examples: [
        "captun deploy",
        "captun deploy --route '*.tunnels.example.com/*'",
        "captun deploy --shards 16",
      ],
    })
    .input(
      z.object({
        route: z
          .string()
          .optional()
          .describe("Optional Worker route, for example *.tunnels.example.com/*"),
        zone: z
          .string()
          .optional()
          .describe("Cloudflare zone name for the route, for example example.com"),
        secret: z
          .string()
          .optional()
          .describe("Secret required by tunnel clients; generated when omitted"),
        shards: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Number of Durable Object shards to spread tunnel names across"),
        dryRun: z.boolean().optional().describe("Compile and validate the deploy without uploading"),
      }),
    )
    .handler(async ({ input }) => {
      const secret = input.secret || randomSecret();
      const serverUrl = await deployWorker({
        route: input.route,
        zone: input.zone,
        secret,
        shards: input.shards,
        dryRun: input.dryRun,
      });
      if (input.dryRun) {
        console.log("\nDry run complete (no upload, config not written).");
        console.log(`Expected server URL pattern: ${serverUrl}`);
        return { serverUrl, dryRun: true };
      }
      await writeConfig({ serverUrl, secret });
      return { serverUrl, configPath };
    }),
});

const cli = createCli({
  router,
  name: "captun",
  version: "0.0.0",
  description: "Expose local HTTP servers through a tiny Cloudflare Worker tunnel.",
});

await cli.run({ prompts, logger: yamlTableConsoleLogger });

async function deployWorker(input: {
  route?: string;
  zone?: string;
  secret: string;
  shards?: number;
  dryRun?: boolean;
}) {
  const tempDir = await mkdtemp(resolve(tmpdir(), "captun-"));
  const secretsFile = resolve(tempDir, "secrets.json");
  try {
    await writeFile(secretsFile, JSON.stringify({ CAPTUN_SECRET: input.secret }), { mode: 0o600 });

    let config = resolve(packageRoot, "wrangler.toml");
    const worker = resolve(packageRoot, "dist/worker.js");
    const args = ["--cwd", packageRoot, "deploy"];
    if (input.route && input.zone) {
      const baseConfig = await readFile(config, "utf8");
      const deployConfig = resolve(tempDir, "wrangler.toml");
      const withMain = baseConfig.replace(/^main\s*=\s*.+$/m, `main = ${JSON.stringify(worker)}`);
      await writeFile(
        deployConfig,
        `${withMain.trimEnd()}\n\n[[routes]]\npattern = ${JSON.stringify(input.route)}\nzone_name = ${JSON.stringify(input.zone)}\n`,
      );
      config = deployConfig;
    } else {
      args.push(worker);
    }
    args.push("--config", config, "--secrets-file", secretsFile, "--keep-vars");
    if (input.route && !input.zone) args.push("--route", input.route);
    if (input.shards) args.push("--var", `CAPTUN_SHARDS:${input.shards}`);
    if (input.dryRun) args.push("--dry-run");

    const output = await runWrangler(args);
    if (input.dryRun) {
      return input.route ? serverUrlFromRoute(input.route) : "https://captun.<your-account>.workers.dev";
    }

    const serverUrl = input.route
      ? serverUrlFromRoute(input.route)
      : serverUrlFromWranglerOutput(output);
    if (!serverUrl) {
      throw new Error("Wrangler deploy succeeded, but the Worker URL was not found in its output.");
    }
    return serverUrl;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function runWrangler(args: string[]) {
  const wrangler = wranglerCommand(args);
  try {
    return (await exec(wrangler.command, wrangler.args, { cwd: packageRoot })).output;
  } catch (error) {
    if (error instanceof CommandNotFoundError) {
      throw new Error(
        "Wrangler is required for `captun deploy`. Install it globally or run `pnpm add -D wrangler` in the project invoking captun.",
      );
    }
    if (error instanceof ExecError) {
      throw new Error(`wrangler deploy failed with exit code ${error.result.exitCode}`);
    }
    throw error;
  }
}

function wranglerCommand(args: string[]) {
  try {
    return {
      command: process.execPath,
      args: [require.resolve("wrangler/bin/wrangler.js"), ...args],
    };
  } catch {
    return { command: "wrangler", args };
  }
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

function serverUrlFromWranglerOutput(output: string) {
  return output.match(/https:\/\/[^\s]+\.workers\.dev[^\s]*/)?.[0];
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
