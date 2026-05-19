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
      const serverUrl = input.serverUrl || process.env.CAPTUN_SERVER_URL || config?.serverUrl;
      if (!serverUrl) {
        throw new Error(
          `No tunnel server configured. Run "captun deploy" first or pass --server-url.`,
        );
      }

      const secret = input.secret || process.env.CAPTUN_SECRET || config?.secret;
      const name = input.name || randomName();
      const tunnel = tunnelUrl(serverUrl, name);
      const origin = `http://127.0.0.1:${input.port}`;

      using _tunnelSession = await createCaptunTunnel({
        url: `${tunnel}/__captun-connect`,
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
      prompt: true,
      examples: ["captun deploy", "captun deploy --route '*.tunnels.example.com/*'"],
    })
    .input(
      z.object({
        route: z
          .string()
          .optional()
          .describe("Optional Worker route, for example *.tunnels.example.com/*"),
        secret: z
          .string()
          .optional()
          .describe("Secret required by tunnel clients; generated when omitted"),
      }),
    )
    .handler(async ({ input }) => {
      const secret = input.secret || randomSecret();
      const serverUrl = await deployWorker({ route: input.route, secret });
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

async function deployWorker(input: { route?: string; secret: string }) {
  const tempDir = await mkdtemp(resolve(tmpdir(), "captun-"));
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

function tunnelUrl(baseUrl: string, name: string) {
  if (baseUrl.includes("{name}")) return removeTrailingSlash(baseUrl.replaceAll("{name}", name));

  const url = new URL(baseUrl);
  if (url.hostname.match(/^[^.]+\.tunnels\./)) {
    url.pathname = "/";
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
  }
  return removeTrailingSlash(url.toString());
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

function removeTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
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
