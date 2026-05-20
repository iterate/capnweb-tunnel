import { expect, test } from "vitest";

import {
  captunHealthResponse,
  confirmTunnelHealth,
  isCaptunHealthRequest,
} from "../src/tunnel-health.js";

test("Captun health requests are reserved for the CLI tunnel", async () => {
  const request = new Request("https://captun.example/__captun/health");

  expect(isCaptunHealthRequest(request)).toBe(true);
  await expect(captunHealthResponse().json()).resolves.toEqual({ ok: true });
});

test("Tunnel health confirmation retries until the tunnel responds", async () => {
  let calls = 0;
  const fetchFn: typeof fetch = async (url) => {
    calls += 1;
    expect(url).toBe("https://captun.example/demo/__captun/health");
    return new Response(null, { status: calls === 1 ? 503 : 200 });
  };

  await confirmTunnelHealth("https://captun.example/demo", {
    fetch: fetchFn,
    retryDelayMs: 1,
    timeoutMs: 100,
  });

  expect(calls).toBe(2);
});
