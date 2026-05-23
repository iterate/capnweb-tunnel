---
status: in-progress
size: medium
---

# Hosted captun.sh rate limits

Status summary: Spec is being carved into a first reviewable slice. The intended first PR adds Worker-level hosted throttles with tests; ownership, paid/custom names, and deeper abuse controls remain follow-up work.

## First hosted throttling slice

- [ ] Add a hosted-only rate-limiter Durable Object. _Keep self-hosted deployments unaffected unless they opt into the hosted `CUSTOM_HOSTNAME=captun.sh` path._
- [ ] Limit tunnel connect attempts per client IP. _Repeated `__captun-connect` upgrades from the same IP should eventually return `429` before reaching a shard._
- [ ] Limit forwarded HTTP requests per client IP and per tunnel name. _A noisy tunnel or source IP should receive `429` without breaking unrelated tunnels._
- [ ] Return useful `429` responses. _Include `Retry-After`, plain text body, and conservative no-store headers._
- [ ] Make limits configurable by Worker vars. _Use safe defaults for the public deployment and allow tests to set tiny limits._
- [ ] Cover limits in Miniflare tests. _Exercise connect throttles, forwarded-request throttles, hosted-only behavior, and reset behavior._
- [ ] Deploy to `captun-public` after merge-ready checks. _Verify hosted public e2e still passes._

## Follow-up safety work

- [ ] Add tunnel ownership tokens so a different anonymous client cannot evict an active tunnel. _This should return `409` for conflicting reconnects rather than silently replacing the active client._
- [ ] Add active tunnel caps and reconnect-churn limits. _Likely needs a global-ish Durable Object keyed separately from the shard count._
- [ ] Add request body, response, and in-flight request caps. _Protect against tunnels used for bulk transfer or resource exhaustion._
- [ ] Add Cloudflare-native Rate Limiting bindings where available. _Use edge throttles for cheaper rejection before Durable Objects wake up._
- [ ] Add observability for 429s, high-volume IPs, high-volume tunnel names, and emergency shutdowns. _Needed before the public hosted service is advertised._

## Implementation Notes

- 2026-05-23: Initial unsafe hosted service is intentionally live but obscure. This task starts the first throttling layer before publicising `captun.sh`.
