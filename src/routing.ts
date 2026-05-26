export const HOSTED_CAPTUN_HOSTNAME = "captun.sh";
export const HOSTED_CAPTUN_GATEWAY = "https://captun.sh";
export const GATEWAY_CONNECT_QUERY_PARAM = "captun-connect";
export const TUNNEL_NAME_QUERY_PARAM = "captun-name";
export const CONNECT_TOKEN_QUERY_PARAM = "captun-token";
export const RESERVED_TUNNEL_NAMES = [
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "captun",
  "dash",
  "dashboard",
  "docs",
  "gateway",
  "gateways",
  "iterate",
  "login",
  "payment",
  "payments",
  "status",
  "support",
  "tunnel",
  "tunnels",
  "www",
];

/**
 * Extracts a tunnel name from an incoming request URL.
 *
 * Two routing modes, picked by whether `customHostname` is set on the Worker:
 *
 * - **No `customHostname`** — folder routing on a `workers.dev` URL. The tunnel
 *   name is the first path segment: `https://captun.acct.workers.dev/banana/x`
 *   maps to the tunnel `banana`.
 *
 * - **`customHostname` set** — subdomain routing relative to that suffix. The
 *   tunnel name is the *last* label of whatever sits to the left of
 *   `customHostname`. Anything further left is ignored, so a nested wildcard
 *   cert (Cloudflare ACM) lets every subdomain land in one named tunnel.
 *
 *   With `customHostname = "tunnels.mydomain.com"`:
 *     `https://banana.tunnels.mydomain.com/x` → `banana`
 *     `https://some-subdomain.banana.tunnels.mydomain.com/x` → `banana`
 *
 *   With `customHostname = "banana.tunnels.mydomain.com"` instead, the same URL
 *   maps to `some-subdomain` — useful for routing arbitrary subdomains into a
 *   single named tunnel via an advanced wildcard cert.
 *
 * Returns null when no valid tunnel name can be parsed.
 */
export function getTunnelNameFromUrl({
  customHostname,
  url,
}: {
  customHostname?: string;
  url: string;
}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (customHostname) {
    if (parsed.hostname === customHostname) return null;
    const suffix = `.${customHostname}`;
    if (!parsed.hostname.endsWith(suffix)) return null;
    const prefix = parsed.hostname.slice(0, -suffix.length);
    if (!prefix) return null;
    const labels = prefix.split(".");
    const name = labels[labels.length - 1];
    return isValidTunnelName(name) ? name : null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const decoded = safeDecodeURIComponent(segments[0]);
  return decoded && isValidTunnelName(decoded) ? decoded : null;
}

/**
 * Inverse of `getTunnelNameFromUrl`: builds the canonical public URL for a
 * tunnel. `reqUrl` is any URL that hits the same Worker — we only use its
 * protocol (and, in folder mode, its host).
 *
 * The Worker calls this before accepting a tunnel client and returns the result
 * through the Cap'n Web ready callback, so the client doesn't have to know the
 * gateway's routing convention to print the right URL.
 */
export function getTunnelUrl({
  reqUrl,
  customHostname,
  tunnelName,
}: {
  reqUrl: string;
  customHostname?: string;
  tunnelName: string;
}): string {
  const parsed = new URL(reqUrl);
  if (customHostname) {
    return `${parsed.protocol}//${tunnelName}.${customHostname}`;
  }
  return `${parsed.protocol}//${parsed.host}/${encodeURIComponent(tunnelName)}`;
}

/** Internal header used by the top-level Worker to pass the canonical tunnel URL to the DO. */
export const TUNNEL_URL_HEADER = "x-captun-tunnel-url";

export function isValidTunnelName(name: string): boolean {
  if (!name) return false;
  return true;
}

/** Maps a tunnel name to a stable Durable Object shard name. */
export function captunShardName(tunnelName: string, shardCount: number) {
  if (!Number.isFinite(shardCount) || shardCount <= 1) return "tunnel-shard-0";
  let hash = 2166136261;
  for (let index = 0; index < tunnelName.length; index++) {
    hash ^= tunnelName.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `tunnel-shard-${(hash >>> 0) % Math.floor(shardCount)}`;
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
