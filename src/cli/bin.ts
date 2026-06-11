#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import * as prompts from "@inquirer/prompts";
import { os } from "@orpc/server";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod/v4";
import { color } from "./ansi.js";
import { CliFriendlyError } from "./cli-error.js";
import {
  CaptunTunnelConnectError,
  createCaptunTunnel,
  HOSTED_CAPTUN_GATEWAY,
  isWebSocketUpgradeRequest,
  pipeWebSocketToHandle,
  randomConnectToken,
  webSocketHandleFromSocket,
  type Fetcher,
  type WebSocketConnectResult,
  type WebSocketFetcher,
  type WebSocketHandle,
} from "../index.js";
import { assertLocalTargetAcceptingConnections } from "./local-target.js";
import { withSpinner } from "./spinner.js";
import {
  captunHealthResponse,
  confirmTunnelHealth,
  isCaptunHealthRequest,
} from "./tunnel-health.js";
import { deployWorker, openInBrowser, runDeployWizard, waitForCertWithSpinner } from "./deploy.js";

export const configSchema = z
  .object({
    gateway: z.url(),
    token: z.string().optional(),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

type TunnelCliInput = {
  target: string;
  name?: string;
  gateway?: string;
  token?: string;
  requestLogs: boolean;
};

export type ResolvedTunnel = {
  name: string;
  gateway: string;
  target: string;
  token?: string;
  requestLogs: boolean;
};

export type TunnelReady = {
  url: string;
  tunnel: ResolvedTunnel;
};

export type CaptunCliRouterOptions = {
  readConfig?: () => Promise<Config | undefined>;
  writeConfig?: (config: Config) => Promise<void>;
  createTunnel?: typeof createCaptunTunnel;
  waitForShutdown?: () => Promise<void>;
  onTunnelReady?: (ready: TunnelReady) => void | Promise<void>;
  tunnelRetries?: number;
};

const adjectives =
  "apple amber bright cedar copper daisy ember forest ginger harbor indigo jolly kiwi lemon maple nova olive pearl quartz ruby".split(
    " ",
  );
const speeds =
  "fast swift quick rapid zippy brisk fleet nimble snappy speedy lively eager sharp ready active bold crisp fresh keen spry".split(
    " ",
  );
const things =
  "tree river stone cloud field bridge spark meadow tower trail garden island planet signal anchor valley window canyon summit harvest".split(
    " ",
  );

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
const configPath = resolve(xdgConfigHome || resolve(homedir(), ".config"), "captun", "config.json");

export function createCaptunCliRouter(options: CaptunCliRouterOptions = {}) {
  const readCliConfig = options.readConfig || readConfig;
  const writeCliConfig = options.writeConfig || writeConfig;
  return os.router({
    tunnel: os
      .meta({
        default: true,
        description: "Expose a local HTTP server through your Captun tunnel Worker.",
        examples: ["captun 3000", "captun 0.0.0.0:5173 --name my-app"],
      })
      .input(
        z.object({
          target: z
            .string()
            .trim()
            .min(1)
            .default("3000")
            .describe("Local target to expose, as a port, host:port, or URL")
            .meta({ positional: true }),
          name: z.string().optional().describe("Tunnel name"),
          gateway: z.url().optional().describe("Tunnel Gateway URL"),
          token: z.string().optional().describe("Tunnel Gateway token"),
          requestLogs: z.boolean().default(true).describe("Print basic request logs"),
        }),
      )
      .handler(async ({ input }) => {
        const config = await readCliConfig();
        if (config) console.log(`${color.dim("Using")} ${color.cyan(configPath)}\n`);

        const tunnel = resolveTunnel(input, config);
        printTunnelOpening(tunnel);
        await runTunnelSession(tunnel, {
          retries: options.tunnelRetries,
          createTunnel: options.createTunnel,
          waitForShutdown: options.waitForShutdown,
          onReady: options.onTunnelReady,
        });
      }),

    deploy: os
      .meta({
        description: "Deploy the Captun tunnel Worker with Wrangler and save local CLI config.",
        prompt: false,
        examples: [
          "captun deploy",
          "captun deploy --route '*.captun.example.com/*'",
          "captun deploy --shards 16",
        ],
      })
      .input(
        z.object({
          name: z
            .string()
            .optional()
            .describe("Worker name (defaults to the value in wrangler.jsonc, which is 'captun')"),
          route: z
            .string()
            .optional()
            .describe("Optional Worker route, for example *.captun.example.com/*"),
          zone: z
            .string()
            .optional()
            .describe("Cloudflare zone name for the route, for example example.com"),
          token: z
            .string()
            .optional()
            .describe("Token required by tunnel clients; generated when omitted"),
          shards: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Number of Durable Object shards to spread tunnel names across"),
          dryRun: z
            .boolean()
            .optional()
            .describe("Compile and validate the deploy without uploading"),
        }),
      )
      .handler(async ({ input }) => {
        const wizardResult = await runDeployWizard(input, { packageRoot });
        const token = wizardResult.token;
        const gateway = await deployWorker(
          {
            name: wizardResult.name,
            route: wizardResult.route,
            zone: wizardResult.zone,
            token,
            shards: wizardResult.shards,
            accountId: wizardResult.accountId,
            customHostname: wizardResult.customHostname,
            dryRun: input.dryRun,
          },
          { packageRoot },
        );
        if (input.dryRun) {
          console.log("\nDry run complete (no upload, config not written).");
          console.log(`Expected gateway: ${gateway}`);
          return { gateway, dryRun: true };
        }

        // Worker is live now — persist config before anything that can fail later
        // (e.g. cert provisioning can time out, but the deploy is already complete).
        await writeCliConfig({ gateway, token });

        if (wizardResult.certWait) {
          try {
            await waitForCertWithSpinner(wizardResult.certWait);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(
              `\n${color.yellow("!")} Certificate provisioning is still pending: ${message}`,
            );
            console.log(
              `  ${color.dim("Config has been saved. Re-run `captun deploy` later (or check the Cloudflare dashboard) once the cert is active.")}`,
            );
          }
        }

        printDeploySummary({
          gateway,
          workerName: wizardResult.name || "captun",
          route: wizardResult.route,
          zone: wizardResult.zone,
          shards: wizardResult.shards || 1,
        });

        if (process.stdin.isTTY) {
          await postDeploySelfTest({
            gateway,
            token,
            workerName: wizardResult.name || "captun",
            route: wizardResult.route,
            zone: wizardResult.zone,
            shards: wizardResult.shards || 1,
          });
        }

        return { gateway, configPath };
      }),
  });
}

export const router = createCaptunCliRouter();

type DeployedSummary = {
  gateway: string;
  workerName: string;
  route?: string;
  zone?: string;
  shards: number;
};

function printDeploySummary(summary: DeployedSummary) {
  console.log(`\n${color.green("Deploy complete")}\n`);
  tunnelInfoRow("worker", color.cyan(summary.workerName));
  if (summary.route) tunnelInfoRow("route", color.cyan(summary.route));
  if (summary.zone) tunnelInfoRow("zone", color.cyan(summary.zone));
  tunnelInfoRow("gateway", color.cyan(summary.gateway));
  tunnelInfoRow("shards", color.cyan(String(summary.shards)));
  tunnelInfoRow("config", color.cyan(configPath));
}

async function postDeploySelfTest(opts: DeployedSummary & { token: string }) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderSuccessPage(opts));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = portOf(server);
  const target = `http://127.0.0.1:${port}`;

  console.log(
    `\n${color.dim("Starting test server at")} ${color.cyan(target)} ${color.dim("for tunnel self-test")}\n`,
  );

  const name = randomName();
  const tunnel: ResolvedTunnel = {
    name,
    gateway: opts.gateway,
    target,
    token: opts.token,
    requestLogs: true,
  };

  printTunnelOpening(tunnel);
  console.log(
    `\n${color.dim("Opening the tunnel URL in your browser to confirm everything works...")}`,
  );

  try {
    await runTunnelSession(tunnel, {
      retries: 6,
      onReady: ({ url }) => openInBrowser(url),
    });
  } finally {
    await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
  }
}

function portOf(server: Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new CliFriendlyError("Could not determine the local test-server port.");
  }
  return addr.port;
}

function renderSuccessPage(opts: DeployedSummary): string {
  const rows: Array<[string, string]> = [
    ["Worker name", opts.workerName],
    ...(opts.route ? [["Route", opts.route] as [string, string]] : []),
    ...(opts.zone ? [["Zone", opts.zone] as [string, string]] : []),
    ["Gateway", opts.gateway],
    ["Shards", String(opts.shards)],
    ["Config file", configPath],
  ];
  const rowHtml = rows
    .map(
      ([label, value]) =>
        `<div class="row"><span class="label">${esc(label)}</span><span class="value">${esc(value)}</span></div>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>captun is working</title>
  <style>
    :root {
      --bg: #0f1115;
      --fg: #e6e8eb;
      --muted: #9aa3af;
      --accent: #38d9a9;
      --card: #1a1d24;
      --border: #2a2f3a;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8f9fb;
        --fg: #11161e;
        --muted: #5b6478;
        --accent: #0e9f6e;
        --card: #ffffff;
        --border: #e3e6eb;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      padding: 3rem 1.5rem;
    }
    main { max-width: 760px; margin: 0 auto; }
    h1 {
      color: var(--accent);
      font-size: clamp(2.4rem, 6vw, 4rem);
      font-weight: 800;
      line-height: 1.1;
      margin: 0 0 0.75rem;
      letter-spacing: -0.02em;
    }
    h2 { font-size: 1rem; margin: 2rem 0 0.5rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    p { margin: 0.5rem 0; }
    .muted { color: var(--muted); }
    .accent { color: var(--accent); }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
    .row { display: flex; gap: 1rem; padding: 0.2rem 0; }
    .row .label { color: var(--muted); width: 8rem; flex-shrink: 0; }
    .row .value { word-break: break-all; }
    pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; overflow-x: auto; margin: 0.4rem 0; }
    a { color: var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>🎉 captun self-test successful!</h1>
    <p class="muted">This page was served by a local HTTP server on your machine, tunneled through your freshly-deployed Cloudflare Worker, and back to your browser. The whole round-trip works.</p>

    <h2>Your deployment</h2>
    <div class="card">${rowHtml}</div>

    <h2>Expose a local server</h2>
    <pre>npx captun 3000</pre>
    <p class="muted">…or pick a tunnel name:</p>
    <pre>npx captun :5173 --name my-app</pre>

    <h2>Use it programmatically</h2>
    <pre>import { createCaptunTunnel } from "captun";</pre>
    <p class="muted">See <a href="https://github.com/iterate/captun">the README</a> for the full API.</p>
  </main>
</body>
</html>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function readConfig() {
  try {
    return configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeConfig(config: Config) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
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

function logRequest(
  enabled: boolean | undefined,
  request: { method: string; path: string; rayId: string; status: number; startedAt: number },
) {
  if (!enabled) return;
  const durationMs = Math.round(performance.now() - request.startedAt);
  console.log(
    [
      colorStatus(request.status),
      color.dim(request.method),
      request.path,
      color.dim(`${durationMs}ms`),
      color.dim(`cf-ray=${request.rayId}`),
    ].join(" "),
  );
}

function colorStatus(status: number) {
  if (status >= 500) return color.red(status);
  if (status >= 400) return color.yellow(status);
  if (status >= 200 && status < 300) return color.green(status);
  return color.dim(status);
}

function resolveTunnel(input: TunnelCliInput, config?: Config): ResolvedTunnel {
  const gateway = input.gateway || config?.gateway || HOSTED_CAPTUN_GATEWAY;

  const name = input.name || randomName();
  const target = normalizeTarget(input.target);
  const token = input.token || config?.token || randomConnectToken();

  return {
    name,
    gateway,
    target,
    token,
    requestLogs: input.requestLogs,
  };
}

function normalizeTarget(target: string) {
  const value = target.trim();
  if (/^\d+$/.test(value)) return `http://127.0.0.1:${value}`;
  if (/^:\d+$/.test(value)) return `http://127.0.0.1${value}`;

  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported tunnel target protocol: ${url.protocol}`);
  }
  return removeTrailingSlash(url.toString());
}

async function runTunnelSession(
  tunnel: ResolvedTunnel,
  opts: {
    retries?: number;
    createTunnel?: typeof createCaptunTunnel;
    waitForShutdown?: () => Promise<void>;
    onReady?: (ready: TunnelReady) => void | Promise<void>;
  } = {},
) {
  const startedAt = performance.now();
  await assertLocalTargetAcceptingConnections(tunnel.target);

  const session = await connectTunnelWithRetry(tunnel, opts.retries || 0, opts.createTunnel);
  try {
    await confirmTunnelHealth(session.url);
    console.log(
      `\n${color.green("Ready")} ${color.dim(`in ${Math.round(performance.now() - startedAt)}ms`)}\n`,
    );
    console.log(color.cyan(session.url));
    console.log(`  ${color.dim("->")} ${color.cyan(tunnel.target)}`);
    console.log(`\n${color.dim("Press Ctrl+C to close tunnel")}\n`);
    await opts.onReady?.({ url: session.url, tunnel });
    await (opts.waitForShutdown || waitForShutdown)();
  } finally {
    session[Symbol.dispose]();
  }
}

async function connectTunnelWithRetry(
  tunnel: ResolvedTunnel,
  retries: number,
  createTunnel = createCaptunTunnel,
) {
  const fetcher = makeTunnelFetcher(tunnel);

  const maxAttempts = retries + 1;
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const label =
      attempt === 1
        ? `Connecting to ${tunnel.gateway}`
        : `Connecting to ${tunnel.gateway} (retry ${attempt - 1}/${retries})`;
    try {
      return await withSpinner(label, () =>
        createTunnel({
          gateway: tunnel.gateway,
          name: tunnel.name,
          token: tunnel.token,
          fetch: fetcher.fetch,
          connectWebSocket: fetcher.connectWebSocket,
        }),
      );
    } catch (error) {
      if (attempt === maxAttempts) {
        throw tunnelConnectError(tunnel, error);
      }
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 8000);
    }
  }
  throw new Error("unreachable");
}

function makeTunnelFetcher(tunnel: ResolvedTunnel): Fetcher & WebSocketFetcher {
  return {
    fetch: async (request: Request) => {
      if (isWebSocketUpgradeRequest(request)) {
        return new Response("Use connectWebSocket for WebSocket tunnel requests\n", {
          status: 400,
        });
      }

      if (isCaptunHealthRequest(request)) return captunHealthResponse();

      const url = new URL(request.url);
      const requestStartedAt = performance.now();
      const rayId = request.headers.get("cf-ray") || "-";
      try {
        const response = await fetch(
          new Request(`${tunnel.target}${url.pathname}${url.search}`, request),
        );
        logRequest(tunnel.requestLogs, {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          rayId,
          status: response.status,
          startedAt: requestStartedAt,
        });
        return response;
      } catch {
        const response = new Response(
          `Request reached the captun cli, but ${tunnel.target} is not accepting connections\n`,
          { status: 502 },
        );
        logRequest(tunnel.requestLogs, {
          method: request.method,
          path: `${url.pathname}${url.search}`,
          rayId,
          status: response.status,
          startedAt: requestStartedAt,
        });
        return response;
      }
    },

    connectWebSocket: (request, remote) => connectTargetWebSocket(tunnel, request, remote),
  };
}

async function connectTargetWebSocket(
  tunnel: ResolvedTunnel,
  request: Request,
  remote: WebSocketHandle,
): Promise<WebSocketConnectResult> {
  const url = new URL(request.url);
  const requestStartedAt = performance.now();
  const log = (status: number) =>
    logRequest(tunnel.requestLogs, {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      rayId: request.headers.get("cf-ray") || "-",
      status,
      startedAt: requestStartedAt,
    });

  const targetUrl = new URL(`${tunnel.target}${url.pathname}${url.search}`);
  targetUrl.protocol = targetUrl.protocol === "https:" ? "wss:" : "ws:";
  const targetSocket = new WebSocket(targetUrl, {
    protocols: request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((protocol) => protocol.trim())
      .filter(Boolean),
    headers: forwardedHandshakeHeaders(request.headers),
    // Node's WebSocket (undici) accepts { protocols, headers }; the DOM type doesn't.
  } as unknown as string[]);

  try {
    await waitForWebSocketOpen(targetSocket);
  } catch {
    targetSocket.close();
    log(502);
    return {
      accepted: false,
      response: new Response(
        `Request reached the captun cli, but ${targetUrl.origin} did not accept the WebSocket\n`,
        { status: 502 },
      ),
    };
  }

  log(101);
  pipeWebSocketToHandle(targetSocket, remote);
  return {
    accepted: true,
    protocol: targetSocket.protocol || undefined,
    socket: webSocketHandleFromSocket(targetSocket),
  };
}

/**
 * Handshake headers to forward to the local WebSocket server, so cookie or
 * token auth behaves the same as tunneled HTTP requests. Hop-by-hop headers
 * and the Sec-WebSocket-* family stay out: the local WebSocket client
 * negotiates its own handshake (subprotocols are passed separately).
 */
function forwardedHandshakeHeaders(headers: Headers) {
  const skip = new Set(["connection", "host", "keep-alive", "te", "trailer", "upgrade"]);
  const forwarded: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (skip.has(name) || name.startsWith("sec-websocket-") || name.startsWith("proxy-")) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

async function waitForWebSocketOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) throw new Error("WebSocket closed before open");

  const listeners = new AbortController();
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const settle = (callback: () => void) => {
      listeners.abort();
      callback();
    };
    socket.addEventListener("open", () => settle(resolveOpen), { signal: listeners.signal });
    socket.addEventListener("error", () => settle(() => rejectOpen(new Error("WebSocket error"))), {
      signal: listeners.signal,
    });
    socket.addEventListener(
      "close",
      () => settle(() => rejectOpen(new Error("WebSocket closed before open"))),
      { signal: listeners.signal },
    );
  });
}

function tunnelConnectError(tunnel: ResolvedTunnel, cause: unknown) {
  const hostname = new URL(tunnel.gateway).hostname;
  const message = cause instanceof Error ? cause.message : String(cause);
  const lines = [`Could not connect tunnel to ${color.cyan(tunnel.gateway)} (${message}).`];
  const connectRejection = cause instanceof CaptunTunnelConnectError ? cause.response : undefined;
  const knownTunnelConflict =
    connectRejection?.status === 409 &&
    connectRejection.body === "Tunnel name is already connected";
  if (!knownTunnelConflict && !hostname.endsWith(".workers.dev")) {
    // Dropping the leftmost label gives the zone-side wildcard parent —
    // `tunnel.mispwoso.com` -> `mispwoso.com`, `t.captun.example.com` -> `captun.example.com`.
    const wildcardParent = hostname.split(".").slice(1).join(".");
    lines.push(
      ``,
      `Likely causes:`,
      `  - DNS for ${color.cyan(hostname)} hasn't propagated yet — wait 30-60 seconds and re-run.`,
      `  - There is no proxied wildcard DNS record on the zone for ${color.cyan(hostname)}.`,
      `    Add an AAAA record with target ${color.cyan("100::")} and proxy enabled.`,
      `  - Universal SSL hasn't issued a certificate covering ${color.cyan(hostname)} yet.`,
      `    Fresh zones can take ~15 minutes; check the SSL/TLS → Edge Certificates dashboard.`,
      `  - The Worker route ${color.cyan(`*.${wildcardParent}/*`)} is not set up — check Workers → Routes.`,
    );
  }
  return new CliFriendlyError(lines.join("\n"));
}

function sleep(ms: number) {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printTunnelOpening(tunnel: ResolvedTunnel) {
  console.log(`${color.dim("Opening tunnel")}`);
  for (const row of tunnelOpeningRows(tunnel)) tunnelInfoRow(row.label, row.value);
}

function tunnelOpeningRows(tunnel: ResolvedTunnel) {
  const rows = [
    { label: "target", value: color.cyan(tunnel.target) },
    { label: "--name", value: color.cyan(tunnel.name) },
    { label: "--gateway", value: color.cyan(tunnel.gateway) },
    {
      label: "--token",
      value: tunnel.token ? color.dim(tokenPreview(tunnel.token)) : color.dim("none"),
    },
  ];
  if (tunnel.requestLogs) rows.push({ label: "--request-logs", value: color.dim("true") });
  return rows;
}

function tunnelInfoRow(label: string, value: string) {
  console.log(`  ${color.dim(label.padEnd(16))}${value}`);
}

function tokenPreview(token: string, visibleChars = 6) {
  if (token.length <= visibleChars) return token;
  return `${token.slice(0, visibleChars)}…`;
}

function randomName() {
  return [pick(adjectives), pick(speeds), pick(things)].join("-");
}

function pick(words: string[]) {
  const word = words[Math.floor(Math.random() * words.length)];
  if (!word) throw new Error("Cannot pick from an empty word list");
  return word;
}

if (isMainModule()) {
  const cli = createCli({
    router,
    name: "captun",
    version: "0.0.0",
    description: "Expose local HTTP servers through a tiny Cloudflare Worker tunnel.",
  });

  await cli.run({
    prompts,
    logger: yamlTableConsoleLogger,
    formatError: (error) =>
      error instanceof CliFriendlyError ? `\n${error.message}\n` : inspect(error),
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return resolve(entry) === fileURLToPath(import.meta.url);
  }
}
