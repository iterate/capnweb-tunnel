export const HOSTED_CAPTUN_HOSTNAME = "captun.sh";
export const HOSTED_CAPTUN_SERVER_URL = "https://{name}.captun.sh";
export const RESERVED_HOSTED_SUBDOMAINS = [
  "app",
  "captun",
  "dash",
  "dashboard",
  "iterate",
  "login",
  "tunnel",
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
 * The Worker calls this and advertises the result back to the tunnel client
 * via the `x-captun-tunnel-url` header on each forwarded request, so the CLI
 * doesn't have to know the routing convention to print the right URL.
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

export function getTunnelUrlFromServerUrl(serverUrl: string, tunnelName: string): string {
  if (serverUrl.includes("{name}"))
    return removeTrailingSlash(serverUrl.replaceAll("{name}", tunnelName));
  const url = new URL(serverUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(tunnelName)}`;
  return removeTrailingSlash(url.toString());
}

/** Header used by the Worker to advertise a tunnel's canonical URL to its client. */
export const TUNNEL_URL_HEADER = "x-captun-tunnel-url";

/** Reserved path used by tunnel clients to open the WebSocket; not a tunnel name. */
const CONNECT_PATH_SEGMENT = "__captun-connect";

function isValidTunnelName(name: string): boolean {
  if (!name) return false;
  if (name === CONNECT_PATH_SEGMENT) return false;
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

function removeTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
}
