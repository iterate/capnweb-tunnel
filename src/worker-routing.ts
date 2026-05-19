import { usesFolderRouting } from "./tunnel-addressing.js";

export const CAPTUN_ACTIVE_TUNNEL_COOKIE = "__captun_active_tunnel";

const CAPTUN_ACTIVE_TUNNEL_MAX_AGE_SECONDS = 60 * 60;
const CAPTUN_TUNNEL_SELECTOR_PREFIX = "/__captun/t/";

export type CaptunRequestRouteParts =
  | {
      kind: "select-active-tunnel";
      name: string;
    }
  | {
      kind: "tunnel";
      name: string;
      path: string;
      rootedByCookie: boolean;
    };

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

/** Extracts a browser-facing Worker route, including cookie-rooted folder routing. */
export function captunRequestRouteParts(
  hostname: string,
  pathname: string,
  cookieHeader: string,
): CaptunRequestRouteParts | undefined {
  const selectorRoute = captunTunnelSelectorRouteParts(hostname, pathname);
  if (selectorRoute) return { kind: "select-active-tunnel", name: selectorRoute.name };

  const directRoute = captunRouteParts(hostname, pathname);
  if (!usesFolderRouting(hostname)) {
    return directRoute
      ? { kind: "tunnel", name: directRoute.name, path: directRoute.path, rootedByCookie: false }
      : undefined;
  }

  if (directRoute && directRoute.path === "/__captun-connect") {
    return { kind: "tunnel", name: directRoute.name, path: directRoute.path, rootedByCookie: false };
  }

  if (isRootCaptunReservedPath(pathname)) return undefined;

  const activeTunnelName = captunActiveTunnelFromCookie(cookieHeader);
  if (activeTunnelName) {
    return { kind: "tunnel", name: activeTunnelName, path: pathname, rootedByCookie: true };
  }

  return directRoute
    ? { kind: "tunnel", name: directRoute.name, path: directRoute.path, rootedByCookie: false }
    : undefined;
}

/** Builds the host-scoped cookie used by folder-routed browser convenience URLs. */
export function captunActiveTunnelSetCookie(tunnelName: string, protocol: string) {
  const parts = [
    `${CAPTUN_ACTIVE_TUNNEL_COOKIE}=${encodeURIComponent(tunnelName)}`,
    "Path=/",
    `Max-Age=${CAPTUN_ACTIVE_TUNNEL_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

/** Removes Captun's routing cookie before requests are forwarded to a local origin. */
export function captunCookieWithoutRoutingCookie(cookieHeader: string) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => cookieName(part) !== CAPTUN_ACTIVE_TUNNEL_COOKIE)
    .join("; ");
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

/** Extracts a valid folder-host selector route, if the path is Captun's selector route. */
function captunTunnelSelectorRouteParts(hostname: string, pathname: string) {
  if (!usesFolderRouting(hostname)) return undefined;
  if (!pathname.startsWith(CAPTUN_TUNNEL_SELECTOR_PREFIX)) return undefined;

  const [encodedName] = pathname.slice(CAPTUN_TUNNEL_SELECTOR_PREFIX.length).split("/");
  if (!encodedName) return undefined;

  const decodedName = safeDecodeURIComponent(encodedName);
  return decodedName ? { name: decodedName } : undefined;
}

/** Reads Captun's active tunnel cookie, ignoring malformed values. */
function captunActiveTunnelFromCookie(cookieHeader: string) {
  for (const rawPart of cookieHeader.split(";")) {
    const part = rawPart.trim();
    if (!part || cookieName(part) !== CAPTUN_ACTIVE_TUNNEL_COOKIE) continue;

    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) return undefined;

    const decodedValue = safeDecodeURIComponent(part.slice(separatorIndex + 1).trim());
    if (decodedValue) return decodedValue;
  }
  return undefined;
}

/** Captun-owned root paths should not be forwarded through an active tunnel cookie. */
function isRootCaptunReservedPath(pathname: string) {
  return pathname === "/__captun-connect" || pathname === "/__captun" || pathname.startsWith("/__captun/");
}

/** Extracts a cookie name from one semicolon-delimited cookie pair. */
function cookieName(cookiePair: string) {
  const separatorIndex = cookiePair.indexOf("=");
  return (separatorIndex === -1 ? cookiePair : cookiePair.slice(0, separatorIndex)).trim();
}

/** Decodes a route segment, returning undefined for malformed percent escapes. */
function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
