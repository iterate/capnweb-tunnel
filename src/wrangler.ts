import { createRequire } from "node:module";

import { CliFriendlyError } from "./cli-error.js";
import { CommandNotFoundError, ExecError, exec, type ExecResult } from "./exec.js";

const require = createRequire(import.meta.url);

type ExecFn = typeof exec;

export type WranglerAccount = {
  id: string;
  name: string;
  type?: string;
};

export type WranglerAuthToken = {
  type: "oauth" | "api-token" | string;
  token: string;
};

export function wranglerCommand(args: string[]) {
  try {
    return {
      command: process.execPath,
      args: [require.resolve("wrangler/bin/wrangler.js"), ...args],
    };
  } catch {
    return { command: "wrangler", args };
  }
}

export async function assertWranglerAuthenticated(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  execFn?: ExecFn;
}) {
  const env = options.env ?? process.env;
  if (env.CLOUDFLARE_API_TOKEN) return;

  const wrangler = wranglerCommand(["whoami", "--json"]);
  try {
    await (options.execFn ?? exec)(wrangler.command, wrangler.args, {
      cwd: options.cwd,
      silent: true,
    });
  } catch (error) {
    if (error instanceof CommandNotFoundError) throw wranglerInstallError();
    if (error instanceof ExecError) throw wranglerAuthError();
    throw error;
  }
}

export async function listAccounts(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  execFn?: ExecFn;
}): Promise<WranglerAccount[]> {
  const wrangler = wranglerCommand(["whoami", "--json"]);
  const result = await (options.execFn ?? exec)(wrangler.command, wrangler.args, {
    cwd: options.cwd,
    silent: true,
  });
  const parsed = parseWranglerJson(result.stdout);
  const accounts: unknown = (parsed as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) {
    throw new CliFriendlyError("wrangler whoami --json did not return an accounts array");
  }
  return accounts
    .filter((entry): entry is { id: string; name: string; type?: string } =>
      typeof entry === "object" && entry !== null
        && typeof (entry as { id?: unknown }).id === "string"
        && typeof (entry as { name?: unknown }).name === "string"
    )
    .map((entry) => ({ id: entry.id, name: entry.name, type: entry.type }));
}

export async function getAuthToken(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  execFn?: ExecFn;
}): Promise<WranglerAuthToken> {
  const env = options.env ?? process.env;
  if (env.CLOUDFLARE_API_TOKEN) {
    return { type: "api-token", token: env.CLOUDFLARE_API_TOKEN };
  }
  const wrangler = wranglerCommand(["auth", "token", "--json"]);
  const result = await (options.execFn ?? exec)(wrangler.command, wrangler.args, {
    cwd: options.cwd,
    silent: true,
  });
  const parsed = parseWranglerJson(result.stdout) as { token?: unknown; type?: unknown };
  if (typeof parsed.token !== "string" || parsed.token.length === 0) {
    throw new CliFriendlyError(
      "wrangler auth token --json did not return a token. Run `wrangler login` first.",
    );
  }
  return { type: typeof parsed.type === "string" ? parsed.type : "oauth", token: parsed.token };
}

function parseWranglerJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const payload = start >= 0 ? stdout.slice(start) : stdout;
  try {
    return JSON.parse(payload);
  } catch {
    throw new CliFriendlyError("Could not parse JSON output from wrangler.");
  }
}

export async function runWrangler(args: string[], options: { cwd: string; tty?: boolean }) {
  const wrangler = wranglerCommand(args);
  try {
    const result: ExecResult = await exec(wrangler.command, wrangler.args, {
      cwd: options.cwd,
      tty: options.tty,
    });
    return result.output;
  } catch (error) {
    if (error instanceof CommandNotFoundError) throw wranglerInstallError();
    if (error instanceof ExecError) {
      throw new CliFriendlyError(`wrangler deploy failed with exit code ${error.result.exitCode}`);
    }
    throw error;
  }
}

function wranglerInstallError() {
  return new CliFriendlyError(
    "Wrangler is required for `captun deploy`. Install it globally or run `pnpm add -D wrangler` in the project invoking captun.",
  );
}

function wranglerAuthError() {
  return new CliFriendlyError(
    "Cloudflare authentication is required for `captun deploy`. Run `wrangler login` or `npx wrangler login` once, or set CLOUDFLARE_API_TOKEN for non-interactive deploys.",
  );
}
