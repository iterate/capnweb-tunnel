import { CliFriendlyError } from "./cli-error.js";

export const captunHealthPath = "/__captun/health";

export type TunnelHealthCheckOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
};

export function isCaptunHealthRequest(request: Request) {
  return new URL(request.url).pathname === captunHealthPath;
}

export function captunHealthResponse() {
  return Response.json({ ok: true });
}

export async function confirmTunnelHealth(
  tunnelUrl: string,
  options: TunnelHealthCheckOptions = {},
) {
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const healthUrl = `${removeTrailingSlash(tunnelUrl)}${captunHealthPath}`;
  const startedAt = performance.now();
  let lastError: unknown;

  while (performance.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetchFn(healthUrl, { cache: "no-store" });
      if (response.ok) return;
      lastError = new Error(`Health check returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(retryDelayMs);
  }

  const suffix = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new CliFriendlyError(
    `Tunnel opened, but health check failed after ${timeoutMs}ms.${suffix}`,
  );
}

function removeTrailingSlash(url: string) {
  return url.replace(/\/$/, "");
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
