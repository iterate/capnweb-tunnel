import { usesFolderRouting } from "./tunnel-addressing.js";

/** Extracts the tunnel name and forwarded path from just the hostname and path. */
export function captunRouteParts(hostname: string, pathname: string) {
  if (!usesFolderRouting(hostname)) {
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

/** Decodes a route segment, returning undefined for malformed percent escapes. */
function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
