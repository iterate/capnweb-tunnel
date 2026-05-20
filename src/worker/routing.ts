/** Routing mode chosen at deploy time and baked into the Worker via CAPTUN_ROUTING_MODE. */
export type RoutingMode = "workers-dev" | "first-level" | "deep-wildcard";

const ROUTING_MODES: readonly RoutingMode[] = ["workers-dev", "first-level", "deep-wildcard"];

export function parseRoutingMode(value: string | undefined): RoutingMode | undefined {
  if (!value) return undefined;
  return ROUTING_MODES.find((mode) => mode === value);
}

/** Extracts the tunnel name and forwarded path from just the hostname and path. */
export function captunRouteParts(
  hostname: string,
  pathname: string,
  options?: { routingMode?: RoutingMode },
) {
  if (!usesFolderRouting(hostname, options?.routingMode)) {
    const [name] = hostname.split(".");
    if (!name) return undefined;
    const decodedName = safeDecodeURIComponent(name);
    return decodedName ? { name: decodedName, path: pathname } : undefined;
  }
  const [name, ...rest] = pathname.split("/").filter(Boolean);
  if (!name || name === "__captun-connect") return undefined;
  const decodedName = safeDecodeURIComponent(name);
  return decodedName ? { name: decodedName, path: `/${rest.join("/")}` } : undefined;
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

/**
 * Decides folder vs subdomain routing.
 *
 * When `routingMode` is provided (read from CAPTUN_ROUTING_MODE on the Worker),
 * it's authoritative — `workers-dev` means folder routing; `first-level` and
 * `deep-wildcard` mean subdomain routing. Otherwise falls back to a hostname
 * heuristic so older deploys (and the CLI's own URL synthesis) keep working.
 */
export function usesFolderRouting(hostname: string, routingMode?: RoutingMode) {
  if (routingMode === "workers-dev") return true;
  if (routingMode === "first-level" || routingMode === "deep-wildcard") return false;
  return (
    hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname.endsWith(".workers.dev") ||
    hostname.startsWith("captun.") ||
    hostname.split(".").length < 3
  );
}

/** Decodes a route segment, returning undefined for malformed percent escapes. */
function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
