---
status: review
size: medium
---

# Hosted captun.sh rate limits

Status summary: First hosted throttling slice is implemented and locally verified. It adds hosted-only connect and forwarded-request limits with configurable Worker vars; this stacked branch also covers anonymous active-tunnel ownership, while paid/custom names and deeper abuse controls remain follow-up work.

## First hosted throttling slice

- [x] Add a hosted-only rate-limiter Durable Object. _`HostedRateLimiter` is bound in `wrangler.jsonc` and only consulted when `CUSTOM_HOSTNAME=captun.sh`._
- [x] Limit tunnel connect attempts per client IP. _`__captun-connect` requests check `connect:ip:<client>` before shard dispatch._
- [x] Limit forwarded HTTP requests per client IP and per tunnel name. _Forwarded hosted requests check both `request:ip:<client>` and `request:tunnel:<name>` buckets._
- [x] Return useful `429` responses. _Hosted throttles return plain text with `Retry-After`, `cache-control: no-store`, and `x-captun-rate-limit`._
- [x] Make limits configurable by Worker vars. _Window and connect/IP/tunnel limits are controlled by `HOSTED_\*_PER_WINDOW` vars with public-service defaults._
- [x] Cover limits in Miniflare tests. _`test/worker.test.ts` covers connect, per-IP request, per-tunnel request, and self-hosted bypass behavior._
- [ ] Deploy to `captun-public` after merge-ready checks. _Not deployed yet; this stacked PR should deploy after review or on explicit request._

## Follow-up safety work

- [x] Add tunnel ownership tokens so a different anonymous client cannot evict an active tunnel. _The stacked hosted-ownership-tokens PR returns `409` for a conflicting active token while allowing same-token replacement._
- [ ] Add active tunnel caps and reconnect-churn limits. _Likely needs a global-ish Durable Object keyed separately from the shard count._
- [ ] Add request body, response, and in-flight request caps. _Protect against tunnels used for bulk transfer or resource exhaustion._
- [ ] Add Cloudflare-native Rate Limiting bindings where available. _Use edge throttles for cheaper rejection before Durable Objects wake up._
- [ ] Add observability for 429s, high-volume IPs, high-volume tunnel names, and emergency shutdowns. _Needed before the public hosted service is advertised._

## Implementation Notes

- 2026-05-23: Initial unsafe hosted service is intentionally live but obscure. This task starts the first throttling layer before publicising `captun.sh`.
- 2026-05-24: Implemented fixed-window in-memory buckets in hosted rate-limiter Durable Objects named by hashed bucket key. This is intentionally a first abuse guardrail, not billing-grade quota accounting.
- 2026-05-24: Review follow-up changed the limiter to fail closed when the binding is missing, added an explicit `HOSTED_RATE_LIMIT_DISABLED=1` escape hatch, and stopped trusting spoofable forwarded-IP headers.
- 2026-05-24: Verified with `pnpm run check`, `pnpm test`, `pnpm run build`, and `CAPTUN_PUBLIC_E2E=1 pnpm vitest run test/public-hosted.test.ts` after retrying one transient live WebSocket-open failure.
