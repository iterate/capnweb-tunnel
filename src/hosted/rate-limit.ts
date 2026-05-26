import { DurableObject } from "cloudflare:workers";

export type HostedRateLimitEnv = {
  HostedRateLimiter?: DurableObjectNamespace<HostedRateLimiter>;
  HOSTED_RATE_LIMIT_WINDOW_SECONDS?: string;
  HOSTED_CONNECTS_PER_IP_PER_WINDOW?: string;
  HOSTED_REQUESTS_PER_IP_PER_WINDOW?: string;
  HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW?: string;
  HOSTED_RATE_LIMIT_DISABLED?: string;
};

const DEFAULT_HOSTED_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_HOSTED_CONNECTS_PER_IP_PER_WINDOW = 30;
const DEFAULT_HOSTED_REQUESTS_PER_IP_PER_WINDOW = 600;
const DEFAULT_HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW = 1200;
const HOSTED_RATE_LIMIT_DIAGNOSTIC_WINDOW_MS = 2_000;

type HostedRateLimitKind = "connect" | "request";

type HostedRateLimitInput = { limit: number; windowSeconds: number };

type HostedRateLimitResult = { ok: true } | { ok: false; limit: number; retryAfterSeconds: number };

type HostedRateLimitBucket = {
  count: number;
  resetAt: number;
  lastRejectedAt?: number;
};

export class HostedRateLimiter extends DurableObject<HostedRateLimitEnv> {
  private bucket: HostedRateLimitBucket | undefined;

  check(input: HostedRateLimitInput): HostedRateLimitResult {
    const now = Date.now();
    const bucket = this.activeBucket(now, now + input.windowSeconds * 1000);
    if (bucket.count >= input.limit) {
      bucket.lastRejectedAt = now;
      return {
        ok: false,
        limit: input.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count++;
    return { ok: true };
  }

  diagnose(input: HostedRateLimitInput): HostedRateLimitResult {
    const now = Date.now();
    const bucket = this.bucket;
    if (
      bucket &&
      bucket.count >= input.limit &&
      bucket.resetAt > now &&
      bucket.lastRejectedAt &&
      now - bucket.lastRejectedAt <= HOSTED_RATE_LIMIT_DIAGNOSTIC_WINDOW_MS
    ) {
      return {
        ok: false,
        limit: input.limit,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    return { ok: true };
  }

  private activeBucket(now: number, resetAt: number): HostedRateLimitBucket {
    if (this.bucket && this.bucket.resetAt > now) return this.bucket;
    const bucket: HostedRateLimitBucket = { count: 0, resetAt };
    this.bucket = bucket;
    return bucket;
  }
}

export async function hostedRateLimitResponse(input: {
  env: HostedRateLimitEnv;
  request: Request;
  tunnelName: string;
  kind: HostedRateLimitKind;
}): Promise<Response | undefined> {
  if (!input.env.HostedRateLimiter) {
    return hostedRateLimiterMissingResponse(input.env);
  }

  const config = hostedRateLimitConfig(input.env);
  const checks = hostedRateLimitChecks({
    kind: input.kind,
    clientKey: hostedClientKey(input.request),
    tunnelName: input.tunnelName,
    config,
  });
  for (const check of checks) {
    const limiter = input.env.HostedRateLimiter.getByName(hostedRateLimiterName(check.key));
    const result = await limiter.check({
      limit: check.limit,
      windowSeconds: config.windowSeconds,
    });
    if (!result.ok) return hostedRateLimitedResponse(result);
  }

  return undefined;
}

export async function hostedRateLimitDiagnosticResponse(input: {
  env: HostedRateLimitEnv;
  request: Request;
  tunnelName: string;
  kind: HostedRateLimitKind;
}): Promise<Response | undefined> {
  if (!input.env.HostedRateLimiter) {
    return hostedRateLimiterMissingResponse(input.env);
  }

  const config = hostedRateLimitConfig(input.env);
  const checks = hostedRateLimitChecks({
    kind: input.kind,
    clientKey: hostedClientKey(input.request),
    tunnelName: input.tunnelName,
    config,
  });
  for (const check of checks) {
    const limiter = input.env.HostedRateLimiter.getByName(hostedRateLimiterName(check.key));
    const result = await limiter.diagnose({
      limit: check.limit,
      windowSeconds: config.windowSeconds,
    });
    if (!result.ok) return hostedRateLimitedResponse(result);
  }

  return undefined;
}

function hostedRateLimiterMissingResponse(env: HostedRateLimitEnv) {
  if (env.HOSTED_RATE_LIMIT_DISABLED === "1") return undefined;
  return new Response("Hosted rate limiter is not configured\n", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function hostedRateLimitedResponse(result: Extract<HostedRateLimitResult, { ok: false }>) {
  return new Response(`Rate limit exceeded. Try again in ${result.retryAfterSeconds}s.\n`, {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(result.retryAfterSeconds),
      "x-captun-rate-limit": String(result.limit),
    },
  });
}

function hostedClientKey(request: Request) {
  return request.headers.get("cf-connecting-ip") || "unknown";
}

function hostedRateLimitChecks(input: {
  kind: HostedRateLimitKind;
  clientKey: string;
  tunnelName: string;
  config: ReturnType<typeof hostedRateLimitConfig>;
}) {
  if (input.kind === "connect") {
    return [{ key: `connect:ip:${input.clientKey}`, limit: input.config.connectsPerIp }];
  }

  return [
    { key: `request:ip:${input.clientKey}`, limit: input.config.requestsPerIp },
    { key: `request:tunnel:${input.tunnelName}`, limit: input.config.requestsPerTunnel },
  ];
}

function hostedRateLimiterName(key: string) {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `bucket-${(hash >>> 0).toString(36)}`;
}

function hostedRateLimitConfig(env: HostedRateLimitEnv) {
  return {
    windowSeconds: positiveInteger(
      env.HOSTED_RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_HOSTED_RATE_LIMIT_WINDOW_SECONDS,
    ),
    connectsPerIp: positiveInteger(
      env.HOSTED_CONNECTS_PER_IP_PER_WINDOW,
      DEFAULT_HOSTED_CONNECTS_PER_IP_PER_WINDOW,
    ),
    requestsPerIp: positiveInteger(
      env.HOSTED_REQUESTS_PER_IP_PER_WINDOW,
      DEFAULT_HOSTED_REQUESTS_PER_IP_PER_WINDOW,
    ),
    requestsPerTunnel: positiveInteger(
      env.HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW,
      DEFAULT_HOSTED_REQUESTS_PER_TUNNEL_PER_WINDOW,
    ),
  };
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}
