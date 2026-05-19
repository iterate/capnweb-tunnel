/** Chooses folder routing for Worker preview hosts, apex domains, and local dev. */
export function usesFolderRouting(hostname: string) {
  return (
    hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname.endsWith(".workers.dev") ||
    hostname.startsWith("tunnels.") ||
    hostname.split(".").length < 3
  );
}

/** Builds the public URL for a named tunnel from a configured server URL. */
export function publicTunnelUrl(baseUrl: string, name: string) {
  if (baseUrl.includes("{name}")) return removeTrailingSlash(baseUrl.replaceAll("{name}", name));

  const url = new URL(baseUrl);
  if (usesFolderRouting(url.hostname)) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
  } else {
    url.pathname = "/";
  }
  return removeTrailingSlash(url.toString());
}

/** Builds the WebSocket connect endpoint for a named tunnel. */
export function tunnelConnectUrl(baseUrl: string, name: string) {
  return `${publicTunnelUrl(baseUrl, name)}/__captun-connect`;
}

/** Infers Captun's server URL pattern from a Cloudflare route pattern. */
export function serverUrlFromRoute(route: string) {
  const withoutProtocol = route.replace(/^https?:\/\//, "");
  const [hostPart, ...pathParts] = withoutProtocol.split("/");
  const host = hostPart?.startsWith("*.") ? `{name}.${hostPart.slice(2)}` : hostPart;
  if (!host) throw new Error(`Cannot infer server URL from route: ${route}`);

  const path = pathParts.join("/").replace(/\*.*$/, "").replace(/\/$/, "");
  return `https://${host}${path ? `/${path}` : ""}`;
}

function removeTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
}
