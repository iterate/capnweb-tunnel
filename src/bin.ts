#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import * as prompts from "@inquirer/prompts";
import { os } from "@orpc/server";
import { createCli, yamlTableConsoleLogger } from "trpc-cli";
import { z } from "zod/v4";
import { color } from "./ansi.js";
import { CliFriendlyError } from "./cli-error.js";
import { createCaptunTunnel } from "./client.js";
import {
  CloudflareApiError,
  createCloudflareClient,
  isAuthError,
  waitForCertificateActive,
  type CloudflareClient,
  type CloudflareZone,
} from "./cloudflare-api.js";
import { assertLocalTargetAcceptingConnections } from "./local-target.js";
import {
  captunHealthResponse,
  confirmTunnelHealth,
  isCaptunHealthRequest,
} from "./tunnel-health.js";
import {
  assertWranglerAuthenticated,
  getAuthToken,
  listAccounts,
  runWrangler,
  type WranglerAccount,
} from "./wrangler.js";

type Config = {
  serverUrl: string;
  secret?: string;
};

type TunnelCliInput = {
  target: string;
  name?: string;
  serverUrl?: string;
  secret?: string;
  requestLogs: boolean;
};

type ResolvedTunnel = {
  name: string;
  serverUrl: string;
  target: string;
  secret?: string;
  requestLogs: boolean;
  tunnel: string;
};

const adjectives = "apple amber bright cedar copper daisy ember forest ginger harbor indigo jolly kiwi lemon maple nova olive pearl quartz ruby".split(" ");
const speeds = "fast swift quick rapid zippy brisk fleet nimble snappy speedy lively eager sharp ready active bold crisp fresh keen spry".split(" ");
const things = "tree river stone cloud field bridge spark meadow tower trail garden island planet signal anchor valley window canyon summit harvest".split(" ");

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const xdgConfigHome = process.env.XDG_CONFIG_HOME;
const configPath = resolve(xdgConfigHome || resolve(homedir(), ".config"), "captun", "config.json");
const CUSTOM_DOMAINS_DOC_URL = "https://github.com/iterate/captun#custom-domains";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const router = os.router({
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
        serverUrl: z.url().optional().describe("Tunnel Worker base URL"),
        secret: z.string().optional().describe("Tunnel connection secret"),
        requestLogs: z.boolean().default(true).describe("Print basic request logs"),
      }),
    )
    .handler(async ({ input }) => {
      const config = await readConfig();
      if (config) console.log(`${color.dim("Using")} ${color.cyan(configPath)}\n`);

      const tunnel = resolveTunnel(input, config);
      printTunnelOpening(tunnel);
      await runTunnelSession(tunnel);
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
      const wizardResult = await runDeployWizard(input);
      const secret = wizardResult.secret;
      const serverUrl = await deployWorker({
        name: wizardResult.name,
        route: wizardResult.route,
        zone: wizardResult.zone,
        secret,
        shards: wizardResult.shards,
        dryRun: input.dryRun,
      });
      if (input.dryRun) {
        console.log("\nDry run complete (no upload, config not written).");
        console.log(`Expected server URL pattern: ${serverUrl}`);
        return { serverUrl, dryRun: true };
      }
      if (wizardResult.certWait) {
        const certWait = wizardResult.certWait;
        const spinner = startSpinner(
          `Waiting for advanced certificate on ${certWait.zoneName} (status: pending_validation)`,
        );
        try {
          await waitForCertificateActive(certWait.client, certWait.zoneId, certWait.packId, {
            onPoll: (pack) =>
              spinner.update(
                `Waiting for advanced certificate on ${certWait.zoneName} (status: ${pack.status})`,
              ),
          });
          spinner.update(`Advanced certificate active on ${certWait.zoneName}`);
          spinner.stop(true);
        } catch (error) {
          spinner.stop(false);
          throw error;
        }
      }
      await writeConfig({ serverUrl, secret });

      printDeploySummary({
        serverUrl,
        workerName: wizardResult.name ?? "captun",
        route: wizardResult.route,
        zone: wizardResult.zone,
        shards: wizardResult.shards ?? 1,
      });

      await postDeploySelfTest({
        serverUrl,
        secret,
        workerName: wizardResult.name ?? "captun",
        route: wizardResult.route,
        zone: wizardResult.zone,
        shards: wizardResult.shards ?? 1,
      });

      return { serverUrl, configPath };
    }),
});


type DeployInput = {
  name?: string;
  route?: string;
  zone?: string;
  secret?: string;
  shards?: number;
  dryRun?: boolean;
};

type DeployWizardResult = {
  name?: string;
  route?: string;
  zone?: string;
  shards?: number;
  secret: string;
  certWait?: {
    client: CloudflareClient;
    zoneId: string;
    zoneName: string;
    packId: string;
  };
};

async function runDeployWizard(input: DeployInput): Promise<DeployWizardResult> {
  if (input.route || !process.stdin.isTTY || input.dryRun) {
    return {
      name: input.name,
      route: input.route,
      zone: input.zone,
      shards: input.shards,
      secret: input.secret ?? randomSecret(),
    };
  }

  console.log(`\n${color.dim("Configuring captun deploy. See")} ${color.cyan(CUSTOM_DOMAINS_DOC_URL)}\n`);

  const accountId = await pickAccount();

  const routingChoice = await prompts.select({
    message: "Where should tunnel URLs live?",
    choices: [
      {
        name: "<tunnel>.<account>.workers.dev/<tunnel-name>",
        value: "workers-dev" as const,
        description:
          "Free, instant. Caveat: tunneled apps run under a path prefix, which breaks apps that assume they live at \"/\" (absolute redirects, OAuth callbacks, cookies scoped to /).",
      },
      {
        name: "<tunnel>.your-domain.com  (pick an existing Cloudflare zone)",
        value: "first-level" as const,
        description:
          "Free, instant. Caveat: the route *.your-domain.com/* will catch every otherwise-unrouted subdomain on the zone — only use this on a domain you've set aside for tunnels.",
      },
      {
        name: "<tunnel>.captun.your-domain.com  (pick an existing zone)",
        value: "deep-wildcard" as const,
        description:
          "Requires Advanced Certificate Manager ($10/month per zone). Wizard orders the cert pack for you. You can change the captun.* subdomain prefix in the next step.",
      },
      {
        name: "Use a dedicated domain (~$9/year to register)",
        value: "dedicated" as const,
        description:
          "Best if you want clean naming without ACM. Requires registering a domain and adding it to Cloudflare first.",
      },
    ],
  });

  let route: string | undefined;
  let zone: string | undefined;
  let certWait: DeployWizardResult["certWait"];

  if (routingChoice === "dedicated") {
    throw new CliFriendlyError(
      [
        "To use a dedicated domain for tunnels:",
        "  1. Register a domain (Cloudflare Registrar or any third-party registrar).",
        "  2. Add it to this Cloudflare account and wait for the zone to become active.",
        "  3. Re-run `captun deploy` and choose \"<tunnel>.your-domain.com\" for that new zone.",
        "",
        `See ${CUSTOM_DOMAINS_DOC_URL} for the full walkthrough.`,
      ].join("\n"),
    );
  }

  if (routingChoice === "first-level" || routingChoice === "deep-wildcard") {
    const { client, pickedZone } = await pickZoneFor(accountId);
    zone = pickedZone.name;
    let dnsRecordName: string;
    if (routingChoice === "first-level") {
      route = `*.${pickedZone.name}/*`;
      dnsRecordName = "*";
    } else {
      const subdomain = await prompts.input({
        message: `Subdomain prefix for tunnels (URLs will look like <tunnel>.<prefix>.${pickedZone.name})`,
        default: "captun",
        validate: (value) =>
          /^[a-z0-9][a-z0-9-]*$/i.test(value)
            ? true
            : "Use letters, digits, and hyphens (no dots; must start with a letter or digit).",
      });
      const fullSubdomain = `${subdomain}.${pickedZone.name}`;
      route = `*.${fullSubdomain}/*`;
      dnsRecordName = `*.${subdomain}`;
      const acmEnabled = await withSpinner(
        `Checking Advanced Certificate Manager on ${pickedZone.name}`,
        () => client.isAdvancedCertificateManagerEnabled(pickedZone.id).catch(() => false),
      );
      if (!acmEnabled) {
        throw new CliFriendlyError(
          [
            `Advanced Certificate Manager (ACM) is required to issue a wildcard certificate for *.${fullSubdomain}, but ACM is not enabled on this zone.`,
            "",
            "Enable ACM on the zone:",
            `  https://dash.cloudflare.com/${accountId}/${pickedZone.name}/ssl-tls/edge-certificates`,
            "",
            "ACM is $10/month per zone. Once enabled, re-run `captun deploy`.",
          ].join("\n"),
        );
      }
      const hosts = [`*.${fullSubdomain}`, fullSubdomain];
      const pack = await withSpinner(
        `Ordering advanced certificate for ${hosts.join(", ")}`,
        () => client.orderAdvancedCertificate(pickedZone.id, hosts),
      ).catch((error: unknown) => {
        if (isAuthError(error)) {
          throw certManagerAuthError(accountId, pickedZone.name);
        }
        if (error instanceof CloudflareApiError) {
          throw new CliFriendlyError(
            `Could not order the advanced certificate: ${error.message} (status ${error.status}${error.cloudflareCode ? `, code ${error.cloudflareCode}` : ""}).`,
          );
        }
        throw error;
      });
      certWait = { client, zoneId: pickedZone.id, zoneName: pickedZone.name, packId: pack.id };
      console.log(`  ${color.dim(`certificate pack ${pack.id} created (status: ${pack.status})`)}`);
    }

    await ensureWildcardDns({
      client,
      accountId,
      zoneId: pickedZone.id,
      zoneName: pickedZone.name,
      dnsRecordName,
    });
  }

  const name = await prompts.input({
    message: "Worker name",
    default: input.name ?? "captun",
    validate: (value) =>
      /^[a-z0-9][a-z0-9-]*$/i.test(value)
        ? true
        : "Use letters, digits, and hyphens (must start with a letter or digit).",
  });

  const shardsAnswer = await prompts.input({
    message:
      "Durable Object shards (advanced — leave as 1 unless you need to create thousands of concurrent tunnels; see README)",
    default: String(input.shards ?? 1),
    validate: (value) => {
      if (!/^\d+$/.test(value)) return "Must be a positive integer";
      return Number(value) >= 1 ? true : "Must be at least 1";
    },
  });
  const shards = Number(shardsAnswer);

  const secret = await prompts.input({
    message:
      "Tunnel secret (leave empty to allow anyone to create tunnels on your captun server)",
    default: input.secret ?? randomSecret(),
  });

  return { name, route, zone, shards, certWait, secret };
}

async function pickAccount(): Promise<string> {
  const accounts = await withSpinner("Loading Cloudflare accounts", () =>
    listAccounts({ cwd: packageRoot }),
  );
  if (accounts.length === 0) {
    throw new CliFriendlyError("No Cloudflare accounts visible from `wrangler whoami`.");
  }
  if (accounts.length === 1) {
    const only = accounts[0];
    if (!only) throw new CliFriendlyError("No Cloudflare accounts visible from `wrangler whoami`.");
    console.log(`${color.dim("Using Cloudflare account")} ${color.cyan(only.name)}\n`);
    return only.id;
  }
  return prompts.select({
    message: "Cloudflare account",
    choices: accounts.map((account: WranglerAccount) => ({
      name: account.name,
      value: account.id,
      description: account.type,
    })),
  });
}

async function pickZoneFor(accountId: string): Promise<{ client: CloudflareClient; pickedZone: CloudflareZone }> {
  const { client, zones } = await withSpinner("Loading Cloudflare zones", async () => {
    const auth = await getAuthToken({ cwd: packageRoot });
    const cloudflare = createCloudflareClient({ token: auth.token });
    const result = await cloudflare.listZones(accountId);
    return { client: cloudflare, zones: result };
  });
  if (zones.length === 0) {
    throw new CliFriendlyError(
      `No active Cloudflare zones found on this account. Add a domain to Cloudflare and try again.`,
    );
  }
  const zoneId = await prompts.select({
    message: "Cloudflare zone",
    choices: zones.map((zone) => ({ name: zone.name, value: zone.id })),
  });
  const pickedZone = zones.find((zone) => zone.id === zoneId);
  if (!pickedZone) throw new CliFriendlyError("Picked zone not found.");
  return { client, pickedZone };
}

async function ensureWildcardDns(opts: {
  client: CloudflareClient;
  accountId: string;
  zoneId: string;
  zoneName: string;
  dnsRecordName: string;
}) {
  const fullDnsName = `${opts.dnsRecordName}.${opts.zoneName}`;

  let existing: Awaited<ReturnType<CloudflareClient["listDnsRecords"]>>;
  let canRead = true;
  try {
    existing = await withSpinner(`Checking DNS for ${fullDnsName}`, () =>
      opts.client.listDnsRecords(opts.zoneId, fullDnsName),
    );
  } catch (error) {
    if (!isAuthError(error)) throw error;
    canRead = false;
    existing = [];
  }

  if (canRead) {
    const proxied = existing.find((record) => record.proxied);
    if (proxied) {
      console.log(
        `  ${color.dim(`existing proxied ${proxied.type} record found for ${fullDnsName} — leaving it alone`)}`,
      );
      return;
    }

    if (existing.length === 0) {
      const created = await tryCreateWildcardDns(opts, fullDnsName);
      if (created) return;
      // create failed with auth — fall through to manual flow
    }
    // Either records exist but unproxied, or create failed: drop into manual flow
  }

  await manualDnsRecoveryFlow({ ...opts, fullDnsName, canRead, existing });
}

async function tryCreateWildcardDns(
  opts: {
    client: CloudflareClient;
    accountId: string;
    zoneId: string;
    zoneName: string;
    dnsRecordName: string;
  },
  fullDnsName: string,
): Promise<boolean> {
  try {
    await withSpinner(`Creating wildcard DNS ${fullDnsName} → 100:: (proxied)`, () =>
      opts.client.createDnsRecord(opts.zoneId, {
        type: "AAAA",
        name: opts.dnsRecordName,
        content: "100::",
        proxied: true,
        comment: "captun: wildcard route to Worker",
      }),
    );
    return true;
  } catch (error) {
    if (isAuthError(error)) return false;
    if (error instanceof CloudflareApiError) {
      throw new CliFriendlyError(
        `Could not create wildcard DNS record for ${fullDnsName}: ${error.message} (status ${error.status}${error.cloudflareCode ? `, code ${error.cloudflareCode}` : ""}).`,
      );
    }
    throw error;
  }
}

async function manualDnsRecoveryFlow(opts: {
  client: CloudflareClient;
  accountId: string;
  zoneId: string;
  zoneName: string;
  dnsRecordName: string;
  fullDnsName: string;
  canRead: boolean;
  existing: Awaited<ReturnType<CloudflareClient["listDnsRecords"]>>;
}) {
  const dashboardUrl = `https://dash.cloudflare.com/${opts.accountId}/${opts.zoneName}/dns/records`;
  const hasUnproxied = opts.canRead && opts.existing.length > 0;

  console.log("");
  console.log(`${color.yellow("!")} ${color.yellow("Manual DNS step needed.")}`);
  if (hasUnproxied) {
    console.log(
      `  ${opts.fullDnsName} has DNS records but none are proxied through Cloudflare.`,
    );
    console.log(
      `  Tunnel traffic only reaches the Worker via proxied records (orange cloud).`,
    );
  } else if (!opts.canRead) {
    console.log(
      `  Wrangler's OAuth token can't read DNS records on this zone, so I can't tell you`,
    );
    console.log(
      `  if a wildcard record already exists. Please make sure one is in place.`,
    );
  } else {
    console.log(
      `  No wildcard DNS record exists for ${opts.fullDnsName}, and wrangler's default`,
    );
    console.log(
      `  OAuth scopes don't include DNS edit permission, so I can't create it for you.`,
    );
  }
  console.log("");
  console.log(`  ${color.dim("Add (or fix) this record in the Cloudflare dashboard:")}`);
  console.log(`    ${color.dim("Type:   ")}${color.cyan("AAAA")}`);
  console.log(`    ${color.dim("Name:   ")}${color.cyan(opts.dnsRecordName)}`);
  console.log(`    ${color.dim("Target: ")}${color.cyan("100::")}`);
  console.log(`    ${color.dim("Proxy:  ")}${color.cyan("enabled (orange cloud)")}`);
  console.log("");
  console.log(`  ${color.dim("Dashboard:")} ${color.cyan(dashboardUrl)}`);
  console.log(
    `  ${color.dim("Or set CLOUDFLARE_API_TOKEN with Zone:DNS:Edit and re-run for full automation.")}`,
  );
  console.log("");

  const shouldOpen = await prompts.confirm({
    message: "Open the Cloudflare DNS page in your browser now?",
    default: true,
  });
  if (shouldOpen) openInBrowser(dashboardUrl);

  for (let attempt = 1; attempt <= 6; attempt++) {
    await prompts.confirm({
      message:
        attempt === 1
          ? "Press enter once you've saved the record (or Ctrl+C to cancel)"
          : `Press enter to re-check (${attempt}/6)`,
      default: true,
    });

    let records: Awaited<ReturnType<CloudflareClient["listDnsRecords"]>>;
    try {
      records = await withSpinner(`Re-checking DNS for ${opts.fullDnsName}`, () =>
        opts.client.listDnsRecords(opts.zoneId, opts.fullDnsName),
      );
    } catch (error) {
      if (isAuthError(error)) {
        console.log(
          `  ${color.dim("(can't verify via API — trusting that you've added the record and continuing)")}`,
        );
        return;
      }
      throw error;
    }

    if (records.find((record) => record.proxied)) {
      console.log(`  ${color.green("✓")} found proxied record for ${opts.fullDnsName}`);
      return;
    }

    if (records.length > 0) {
      console.log(
        `  ${color.yellow("Found records but none are proxied.")} Toggle the orange-cloud proxy on, then press enter again.`,
      );
    } else {
      console.log(
        `  ${color.yellow("No matching record yet.")} The DNS API can lag a few seconds — give it a moment, or double-check the name (${color.cyan(opts.dnsRecordName)}).`,
      );
    }
  }

  throw new CliFriendlyError(
    `Gave up after 6 attempts waiting for the wildcard DNS record on ${opts.fullDnsName}. Add it and re-run \`captun deploy\`.`,
  );
}

function certManagerAuthError(accountId: string, zoneName: string) {
  return new CliFriendlyError(
    [
      `Cannot order the Advanced Certificate via your current Cloudflare credentials.`,
      ``,
      `Wrangler's default OAuth scopes don't include edge SSL edit permission. Two options:`,
      ``,
      `${color.cyan("1.")} Order the certificate manually in the dashboard:`,
      `     ${color.cyan(`https://dash.cloudflare.com/${accountId}/${zoneName}/ssl-tls/edge-certificates`)}`,
      ``,
      `${color.cyan("2.")} Use a Cloudflare API Token with ${color.cyan("Zone → SSL and Certificates → Edit")} permission:`,
      `     ${color.cyan("https://dash.cloudflare.com/profile/api-tokens")}`,
      ``,
      `     Then re-run with ${color.cyan("CLOUDFLARE_API_TOKEN=… npx captun deploy")}.`,
    ].join("\n"),
  );
}

type Spinner = {
  update(message: string): void;
  stop(success?: boolean): void;
};

function startSpinner(initial: string): Spinner {
  if (!process.stdout.isTTY) {
    console.log(`  ${initial}...`);
    let label = initial;
    return {
      update: (message) => {
        label = message;
        console.log(`  ${message}`);
      },
      stop: (success = true) => {
        console.log(`  ${success ? "done" : "failed"}: ${label}`);
      },
    };
  }
  let label = initial;
  let frame = 0;
  const render = () => {
    process.stdout.write(`\r${color.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "")} ${label}\x1b[K`);
    frame += 1;
  };
  render();
  const interval = setInterval(render, 80);
  return {
    update: (message) => {
      label = message;
      render();
    },
    stop: (success = true) => {
      clearInterval(interval);
      const mark = success ? color.green("✓") : color.red("✗");
      process.stdout.write(`\r${mark} ${label}\x1b[K\n`);
    },
  };
}

async function withSpinner<T>(message: string, fn: () => Promise<T>): Promise<T> {
  const spinner = startSpinner(message);
  try {
    const result = await fn();
    spinner.stop(true);
    return result;
  } catch (error) {
    spinner.stop(false);
    throw error;
  }
}

async function deployWorker(input: {
  name?: string;
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

    const baseConfigPath = resolve(packageRoot, "wrangler.jsonc");
    const baseConfig = JSON.parse(await readFile(baseConfigPath, "utf8")) as Record<string, unknown>;
    const worker = resolve(packageRoot, "dist/worker.js");
    baseConfig.main = worker;
    if (input.name) baseConfig.name = input.name;
    if (input.route && input.zone) {
      const existingRoutes = Array.isArray(baseConfig.routes) ? baseConfig.routes : [];
      baseConfig.routes = [...existingRoutes, { pattern: input.route, zone_name: input.zone }];
      baseConfig.workers_dev = false;
    }
    const deployConfig = resolve(tempDir, "wrangler.json");
    await writeFile(deployConfig, JSON.stringify(baseConfig, null, 2));

    const args = ["--cwd", packageRoot, "deploy"];
    args.push("--config", deployConfig, "--secrets-file", secretsFile, "--keep-vars");
    if (input.route && !input.zone) args.push("--route", input.route);
    if (input.shards) args.push("--var", `CAPTUN_SHARDS:${input.shards}`);
    if (input.dryRun) args.push("--dry-run");

    if (!input.dryRun) await assertWranglerAuthenticated({ cwd: packageRoot });

    const output = await runWrangler(args, { cwd: packageRoot, tty: !input.dryRun });
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

type DeployedSummary = {
  serverUrl: string;
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
  tunnelInfoRow("server url", color.cyan(summary.serverUrl));
  tunnelInfoRow("shards", color.cyan(String(summary.shards)));
  tunnelInfoRow("config", color.cyan(configPath));
}

async function postDeploySelfTest(opts: DeployedSummary & { secret: string }) {
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

  console.log(`\n${color.dim("Starting test server at")} ${color.cyan(target)} ${color.dim("for tunnel self-test")}\n`);

  const name = randomName();
  const tunnel: ResolvedTunnel = {
    name,
    serverUrl: opts.serverUrl,
    target,
    secret: opts.secret,
    requestLogs: true,
    tunnel: tunnelUrl(opts.serverUrl, name),
  };

  printTunnelOpening(tunnel);
  console.log(
    `\n${color.dim("Opening the tunnel URL in your browser to confirm everything works...")}`,
  );

  try {
    await runTunnelSession(tunnel, {
      retries: 6,
      onReady: () => openInBrowser(tunnel.tunnel),
    });
  } finally {
    await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
  }
}

function openInBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: process.platform === "win32" });
    child.on("error", () => {
      // best-effort: ignore failures
    });
    child.unref();
  } catch {
    // best-effort: ignore failures
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
    ["Server URL", opts.serverUrl],
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
    <pre>import { createCaptunTunnel } from "captun/client";</pre>
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
  const serverUrl = input.serverUrl ?? config?.serverUrl;
  if (!serverUrl) {
    throw new Error(
      `No tunnel server configured. Run "captun deploy" first or pass --server-url.`,
    );
  }

  const name = input.name ?? randomName();
  const target = normalizeTarget(input.target);

  return {
    name,
    serverUrl,
    target,
    secret: input.secret ?? config?.secret,
    requestLogs: input.requestLogs,
    tunnel: tunnelUrl(serverUrl, name),
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
  opts: { retries?: number; onReady?: () => void } = {},
) {
  const startedAt = performance.now();
  await assertLocalTargetAcceptingConnections(tunnel.target);

  const session = await connectTunnelWithRetry(tunnel, opts.retries ?? 0);
  try {
    await confirmTunnelHealth(tunnel.tunnel);
    console.log(`\n${color.green("Ready")} ${color.dim(`in ${Math.round(performance.now() - startedAt)}ms`)}\n`);
    console.log(color.cyan(tunnel.tunnel));
    console.log(`  ${color.dim("->")} ${color.cyan(tunnel.target)}`);
    console.log(`\n${color.dim("Press Ctrl+C to close tunnel")}\n`);
    opts.onReady?.();
    await waitForShutdown();
  } finally {
    session[Symbol.dispose]();
  }
}

async function connectTunnelWithRetry(tunnel: ResolvedTunnel, retries: number) {
  const url = `${tunnel.tunnel}/__captun-connect`;
  const headers = tunnel.secret ? { authorization: `Bearer ${tunnel.secret}` } : undefined;
  const fetcher = makeTunnelFetcher(tunnel);

  const maxAttempts = retries + 1;
  let delay = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const label =
      attempt === 1
        ? `Connecting to ${tunnel.tunnel}`
        : `Connecting to ${tunnel.tunnel} (retry ${attempt - 1}/${retries})`;
    try {
      return await withSpinner(label, () => createCaptunTunnel({ url, headers, fetch: fetcher }));
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

function makeTunnelFetcher(tunnel: ResolvedTunnel) {
  return async (request: Request) => {
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
  };
}

function tunnelConnectError(tunnel: ResolvedTunnel, cause: unknown) {
  const hostname = new URL(tunnel.tunnel).hostname;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new CliFriendlyError(
    [
      `Could not connect tunnel to ${color.cyan(tunnel.tunnel)} (${message}).`,
      ``,
      `Likely causes:`,
      `  - DNS for ${color.cyan(hostname)} hasn't propagated yet — wait 30-60 seconds and re-run.`,
      `  - There is no proxied wildcard DNS record on the zone for ${color.cyan(hostname)}.`,
      `    Add an AAAA record with target ${color.cyan("100::")} and proxy enabled.`,
      `  - Universal SSL hasn't issued a certificate covering ${color.cyan(hostname)} yet.`,
      `    Fresh zones can take ~15 minutes; check the SSL/TLS → Edge Certificates dashboard.`,
      `  - The Worker route ${color.cyan(`*.${hostname.split(".").slice(-2).join(".")}/*`)} is not set up — check Workers → Routes.`,
    ].join("\n"),
  );
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
    { label: "--server-url", value: color.cyan(tunnel.serverUrl) },
    {
      label: "--secret",
      value: tunnel.secret ? color.dim(secretPreview(tunnel.secret)) : color.dim("none"),
    },
  ];
  if (tunnel.requestLogs) rows.push({ label: "--request-logs", value: color.dim("true") });
  return rows;
}

function tunnelInfoRow(label: string, value: string) {
  console.log(`  ${color.dim(label.padEnd(16))}${value}`);
}

function secretPreview(secret: string, visibleChars = 6) {
  if (secret.length <= visibleChars) return secret;
  return `${secret.slice(0, visibleChars)}…`;
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

const cli = createCli({
  router,
  name: "captun",
  version: "0.0.0",
  description: "Expose local HTTP servers through a tiny Cloudflare Worker tunnel.",
});

await cli.run({
  prompts,
  logger: yamlTableConsoleLogger,
  formatError: (error) => (error instanceof CliFriendlyError ? `\n${error.message}\n` : inspect(error)),
});

