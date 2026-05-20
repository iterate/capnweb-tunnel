import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import * as prompts from "@inquirer/prompts";
import { color } from "./ansi.js";
import { CliFriendlyError } from "./cli-error.js";
import { startSpinner, withSpinner } from "./spinner.js";
import {
  CloudflareApiError,
  createCloudflareClient,
  isAuthError,
  waitForCertificateActive,
  type CloudflareClient,
  type CloudflareZone,
} from "./cloudflare-api.js";
import type { RoutingMode } from "../routing.js";
import {
  assertWranglerAuthenticated,
  getAuthToken,
  listAccounts,
  runWrangler,
  type WranglerAccount,
} from "./wrangler.js";

export const CUSTOM_DOMAINS_DOC_URL = "https://github.com/iterate/captun#custom-domains";

export type DeployInput = {
  name?: string;
  route?: string;
  zone?: string;
  secret?: string;
  shards?: number;
  dryRun?: boolean;
};

export type DeployWizardResult = {
  name?: string;
  route?: string;
  zone?: string;
  shards?: number;
  secret: string;
  accountId?: string;
  routingMode?: RoutingMode;
  certWait?: {
    client: CloudflareClient;
    zoneId: string;
    zoneName: string;
    packId: string;
  };
};

export async function runDeployWizard(
  input: DeployInput,
  options: { packageRoot: string },
): Promise<DeployWizardResult> {
  if (input.route || !process.stdin.isTTY || input.dryRun) {
    return {
      name: input.name,
      route: input.route,
      zone: input.zone,
      shards: input.shards,
      secret: input.secret ?? randomSecret(),
    };
  }

  console.log(
    `\n${color.dim("Configuring captun deploy. See")} ${color.cyan(CUSTOM_DOMAINS_DOC_URL)}\n`,
  );

  const accountId = await pickAccount(options.packageRoot);

  const useOwnDomain = await prompts.select({
    message: "Where should tunnel URLs live?",
    choices: [
      {
        name: "workers.dev domain  (free, instant)",
        value: false,
        description:
          'Tunnel URLs look like <tunnel>.<account>.workers.dev/<tunnel-name>. Caveat: tunneled apps run under a path prefix, which breaks apps that assume they live at "/" (absolute redirects, OAuth callbacks, cookies scoped to /).',
      },
      {
        name: "Use my own domain  (pick an existing Cloudflare zone)",
        value: true,
        description:
          "Tunnels get clean URLs on your own domain. Requires a domain already added to this Cloudflare account.",
      },
    ],
  });

  let route: string | undefined;
  let zone: string | undefined;
  let certWait: DeployWizardResult["certWait"];
  let routingMode: RoutingMode = "workers-dev";

  if (useOwnDomain) {
    const { client, pickedZone } = await pickZoneFor(accountId, options.packageRoot);
    zone = pickedZone.name;

    const subdomainChoice = await prompts.select({
      message: `How should tunnels map to ${pickedZone.name}?`,
      choices: [
        {
          name: `<tunnel>.${pickedZone.name}  (free, instant)`,
          value: "first-level" as const,
          description: `Caveat: the route *.${pickedZone.name}/* will catch every otherwise-unrouted subdomain on the zone — only use this on a domain you've set aside for tunnels.`,
        },
        {
          name: `<tunnel>.captun.${pickedZone.name}  (configurable prefix)`,
          value: "deep-wildcard" as const,
          description:
            "Requires Advanced Certificate Manager ($10/month per zone). Wizard orders the cert pack for you. (You can configure the captun.* subdomain.)",
        },
      ],
    });

    routingMode = subdomainChoice;
    let dnsRecordName: string;
    if (subdomainChoice === "first-level") {
      route = `*.${pickedZone.name}/*`;
      dnsRecordName = "*";
      await confirmRoutingPlan({
        accountId,
        zoneName: pickedZone.name,
        choice: subdomainChoice,
        fullSubdomain: pickedZone.name,
      });
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
      await confirmRoutingPlan({
        accountId,
        zoneName: pickedZone.name,
        choice: subdomainChoice,
        fullSubdomain,
      });
      const acmEnabled = await withSpinner(
        `Checking Advanced Certificate Manager on ${pickedZone.name}`,
        () => client.isAdvancedCertificateManagerEnabled(pickedZone.id),
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
      const pack = await withSpinner(`Ordering advanced certificate for ${hosts.join(", ")}`, () =>
        client.orderAdvancedCertificate(pickedZone.id, hosts),
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
    message: "Tunnel secret (leave empty to allow anyone to create tunnels on your captun server)",
    default: input.secret ?? randomSecret(),
  });

  return { name, route, zone, shards, certWait, secret, accountId, routingMode };
}

async function pickAccount(packageRoot: string): Promise<string> {
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

async function pickZoneFor(
  accountId: string,
  packageRoot: string,
): Promise<{ client: CloudflareClient; pickedZone: CloudflareZone }> {
  const { client, zones } = await withSpinner("Loading Cloudflare zones", async () => {
    const auth = await getAuthToken({ cwd: packageRoot });
    const cloudflare = createCloudflareClient({ token: auth.token });
    const result = await cloudflare.listZones(accountId);
    return { client: cloudflare, zones: result };
  });
  if (zones.length === 0) {
    throw new CliFriendlyError(
      [
        "No active Cloudflare zones found on this account.",
        "",
        "To use your own domain for tunnels:",
        "  1. Register a domain (Cloudflare Registrar or any third-party registrar).",
        "  2. Add it to this Cloudflare account and wait for the zone to become active.",
        "  3. Re-run `captun deploy`.",
        "",
        `See ${CUSTOM_DOMAINS_DOC_URL} for the full walkthrough.`,
      ].join("\n"),
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

type RoutingPlan = {
  accountId: string;
  zoneName: string;
  choice: "first-level" | "deep-wildcard";
  fullSubdomain: string;
};

async function confirmRoutingPlan(plan: RoutingPlan) {
  const steps = [
    `Add a proxied wildcard AAAA DNS record for *.${plan.fullSubdomain} (target 100::) on ${plan.zoneName}`,
    `Deploy a Cloudflare Worker with the route *.${plan.fullSubdomain}/*`,
  ];
  if (plan.choice === "deep-wildcard") {
    steps.unshift(
      `Check Advanced Certificate Manager is enabled on ${plan.zoneName}`,
      `Order an advanced certificate pack covering *.${plan.fullSubdomain} and ${plan.fullSubdomain}`,
    );
  }

  const agentPrompt =
    plan.choice === "first-level"
      ? `Walk me through setting up *.${plan.zoneName} on Cloudflare so that all subdomains route to a single Cloudflare Worker. I want a proxied AAAA wildcard DNS record (target 100::) and a Worker route *.${plan.zoneName}/*. Universal SSL should cover the first-level wildcard — no ACM needed. Walk me through each dashboard step.`
      : `Walk me through setting up *.${plan.fullSubdomain} on Cloudflare so that all subdomains under ${plan.fullSubdomain} route to a single Cloudflare Worker. This is a deep wildcard so I need Advanced Certificate Manager ($10/month) and an advanced certificate pack covering *.${plan.fullSubdomain} and ${plan.fullSubdomain}. I also need a proxied AAAA wildcard DNS record (target 100::) and a Worker route *.${plan.fullSubdomain}/*. Walk me through each dashboard step.`;

  console.log("");
  console.log(
    `${color.dim("About to make these changes on")} ${color.cyan(plan.zoneName)}${color.dim(":")}`,
  );
  for (const step of steps) console.log(`  ${color.dim("-")} ${step}`);
  console.log("");
  console.log(
    `  ${color.dim("Prefer to drive this yourself? Paste this into your favorite AI agent:")}`,
  );
  console.log(`  ${color.dim(">")} ${color.cyan(agentPrompt)}`);
  console.log("");

  const proceed = await prompts.confirm({
    message: "Proceed with automatic setup?",
    default: true,
  });
  if (!proceed) {
    throw new CliFriendlyError(
      "Cancelled. Re-run `captun deploy` once you've set things up manually (or with help from an agent).",
    );
  }
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
    console.log(`  ${opts.fullDnsName} has DNS records but none are proxied through Cloudflare.`);
    console.log(`  Tunnel traffic only reaches the Worker via proxied records (orange cloud).`);
  } else if (!opts.canRead) {
    console.log(
      `  Wrangler's OAuth token can't read DNS records on this zone, so I can't tell you`,
    );
    console.log(`  if a wildcard record already exists. Please make sure one is in place.`);
  } else {
    console.log(`  No wildcard DNS record exists for ${opts.fullDnsName}, and wrangler's default`);
    console.log(`  OAuth scopes don't include DNS edit permission, so I can't create it for you.`);
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

export async function deployWorker(
  input: {
    name?: string;
    route?: string;
    zone?: string;
    secret: string;
    shards?: number;
    accountId?: string;
    routingMode?: RoutingMode;
    dryRun?: boolean;
  },
  options: { packageRoot: string },
) {
  const { packageRoot } = options;
  const tempDir = await mkdtemp(resolve(tmpdir(), "captun-"));
  const secretsFile = resolve(tempDir, "secrets.json");
  try {
    await writeFile(secretsFile, JSON.stringify({ CAPTUN_SECRET: input.secret }), { mode: 0o600 });

    const baseConfigPath = resolve(packageRoot, "wrangler.jsonc");
    const baseConfig = parseJsonc(await readFile(baseConfigPath, "utf8")) as Record<
      string,
      unknown
    >;
    const worker = resolve(packageRoot, "dist/worker.js");
    baseConfig.main = worker;
    if (input.name) baseConfig.name = input.name;
    if (input.accountId) baseConfig.account_id = input.accountId;
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
    if (input.routingMode) args.push("--var", `CAPTUN_ROUTING_MODE:${input.routingMode}`);
    if (input.dryRun) args.push("--dry-run");

    if (!input.dryRun) await assertWranglerAuthenticated({ cwd: packageRoot });

    const output = await runWrangler(args, { cwd: packageRoot, tty: !input.dryRun });
    if (input.dryRun) {
      return input.route
        ? serverUrlFromRoute(input.route)
        : "https://captun.<your-account>.workers.dev";
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

export async function waitForCertWithSpinner(
  certWait: NonNullable<DeployWizardResult["certWait"]>,
) {
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

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

/** Minimal JSONC parser: strips line/block comments and trailing commas. */
function parseJsonc(input: string): unknown {
  const withoutComments = input.replace(
    /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, str: string | undefined) => str ?? "",
  );
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

export function openInBrowser(url: string) {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const args = process.platform === "win32" ? ["", url] : [url];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", () => {
      // best-effort: ignore failures
    });
    child.unref();
  } catch {
    // best-effort: ignore failures
  }
}
