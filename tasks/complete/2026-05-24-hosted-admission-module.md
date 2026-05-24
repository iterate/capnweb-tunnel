status: complete
size: small

# Hosted Admission Module

Status summary: Complete and locally verified. Hosted anonymous tunnel admission now lives in a small direct-testable module, while `CaptunServerShard` only supplies active tunnel state and performs WebSocket acceptance.

## Checklist

- [x] Extract a hosted tunnel admission module. _`src/hosted-admission.ts` now owns secret auth, hosted anonymous owner-token parsing, token validation, and active-owner conflict decisions._
- [x] Keep the Durable Object focused on active tunnel state and WebSocket acceptance. _`CaptunServerShard.fetch` now calls `decideTunnelAdmission` with the current active owner token, then disposes/replaces the tunnel when admitted._
- [x] Add direct tests for the admission decision. _`test/hosted-admission.test.ts` covers self-hosted bypass, secret auth, missing/invalid hosted tokens, same-owner replace, and different-owner conflict._
- [x] Keep integration coverage passing. _Existing Worker ownership tests still cover Durable Object wiring; the conflict test now reads the rejection body before the follow-up forwarded request to avoid Miniflare response-body flakiness._
- [x] Run focused and full verification. _Verified with focused Vitest, `pnpm run check`, `pnpm test`, and `pnpm run build`._

## Assumptions

- This is stacked on `mmkal/26/05/24/hosted-connect-conflict-message`.
- This is an architecture-only change; hosted behavior, response status codes, and response bodies should stay compatible.
- The module interface should be small enough that future hosted safety checks can be added there without growing `CaptunServerShard.fetch`.

## Implementation Notes

- 2026-05-24: Nightly architecture pass recommended this because ownership-token safety policy was embedded in the Durable Object implementation, forcing integration setup for pure admission-policy cases.
- 2026-05-24: Replaced the Worker-specific `crypto.subtle.timingSafeEqual` call with a local constant-time string comparison so the admission module can be tested directly in Node while retaining fixed-work secret comparison behavior.
- 2026-05-24: Bugbot follow-up made secret-auth hosted admission ignore stale anonymous owner tokens, since setting `CAPTUN_SECRET` disables anonymous ownership policy.
