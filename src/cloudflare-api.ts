import { CliFriendlyError } from "./cli-error.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

export type CloudflareZone = {
  id: string;
  name: string;
  status: string;
};

export type CertificatePack = {
  id: string;
  status: string;
  hosts: string[];
};

export type CloudflareClient = {
  listZones(accountId: string): Promise<CloudflareZone[]>;
  isAdvancedCertificateManagerEnabled(zoneId: string): Promise<boolean>;
  orderAdvancedCertificate(zoneId: string, hosts: string[]): Promise<CertificatePack>;
  getCertificatePack(zoneId: string, packId: string): Promise<CertificatePack>;
};

export function createCloudflareClient(options: {
  token: string;
  fetchFn?: typeof fetch;
}): CloudflareClient {
  const fetchFn = options.fetchFn ?? fetch;
  const headers = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  } as const;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchFn(`${API_BASE}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
    const body = (await response.json().catch(() => undefined)) as
      | { success?: boolean; result?: T; errors?: Array<{ code: number; message: string }> }
      | undefined;
    if (!response.ok || !body?.success) {
      const message = body?.errors?.[0]?.message ?? `Cloudflare API request failed: ${response.status}`;
      const code = body?.errors?.[0]?.code;
      throw new CloudflareApiError(message, response.status, code);
    }
    return body.result as T;
  }

  return {
    async listZones(accountId) {
      const result = await request<CloudflareZone[]>(
        `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50&status=active`,
      );
      return result.map((zone) => ({ id: zone.id, name: zone.name, status: zone.status }));
    },

    async isAdvancedCertificateManagerEnabled(zoneId) {
      try {
        const result = await request<{ rate_plan?: { id?: string }; component_values?: Array<{ name?: string }> }>(
          `/zones/${zoneId}/subscription`,
        );
        const componentNames = (result.component_values ?? [])
          .map((entry) => entry.name)
          .filter((name): name is string => typeof name === "string");
        if (componentNames.some((name) => name.toLowerCase().includes("advanced_certificate_manager"))) {
          return true;
        }
        const ratePlanId = result.rate_plan?.id?.toLowerCase() ?? "";
        if (ratePlanId.includes("advanced_certificate_manager")) return true;
        return false;
      } catch (error) {
        if (error instanceof CloudflareApiError && (error.status === 404 || error.status === 403)) {
          return false;
        }
        throw error;
      }
    },

    async orderAdvancedCertificate(zoneId, hosts) {
      return request<CertificatePack>(`/zones/${zoneId}/ssl/certificate_packs/order`, {
        method: "POST",
        body: JSON.stringify({
          type: "advanced",
          hosts,
          validation_method: "txt",
          validity_days: 90,
          certificate_authority: "lets_encrypt",
          cloudflare_branding: false,
        }),
      });
    },

    async getCertificatePack(zoneId, packId) {
      return request<CertificatePack>(`/zones/${zoneId}/ssl/certificate_packs/${packId}`);
    },
  };
}

export class CloudflareApiError extends Error {
  status: number;
  cloudflareCode?: number;

  constructor(message: string, status: number, cloudflareCode?: number) {
    super(message);
    this.status = status;
    this.cloudflareCode = cloudflareCode;
  }
}

export async function waitForCertificateActive(
  client: CloudflareClient,
  zoneId: string,
  packId: string,
  options: { timeoutMs?: number; intervalMs?: number; onPoll?: (pack: CertificatePack) => void } = {},
) {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pack = await client.getCertificatePack(zoneId, packId);
    options.onPoll?.(pack);
    if (pack.status === "active") return pack;
    if (pack.status === "deleted" || pack.status === "expired") {
      throw new CliFriendlyError(`Certificate pack ${packId} ended up in status "${pack.status}".`);
    }
    await sleep(intervalMs);
  }
  throw new CliFriendlyError(
    `Certificate pack ${packId} did not become active within ${Math.round(timeoutMs / 1000)}s. ` +
      "It is still being provisioned in the background; you can re-run `captun deploy` after it finishes.",
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}
