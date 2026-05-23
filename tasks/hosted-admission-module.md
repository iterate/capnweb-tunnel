status: ready
size: small

# Hosted Admission Module

Status summary: Spec only. Extract the hosted anonymous tunnel admission decision out of `CaptunServerShard` so ownership-token policy has a small direct test surface. No product behavior should change.

## Checklist

- [ ] Extract a hosted tunnel admission module. _Move secret auth, hosted anonymous owner-token parsing, token validation, and active-owner conflict decisions behind one function._
- [ ] Keep the Durable Object focused on active tunnel state and WebSocket acceptance. _`CaptunServerShard.fetch` should ask the admission module for allow/reject and then replace/store the tunnel._
- [ ] Add direct tests for the admission decision. _Cover self-hosted bypass, secret auth, missing/invalid hosted token, same-owner replace, and different-owner conflict without needing a full tunnel connection._
- [ ] Keep integration coverage passing. _Existing Worker ownership tests should still cover the Durable Object wiring._
- [ ] Run focused and full verification. _Use focused Vitest, `pnpm run check`, `pnpm test`, and `pnpm run build`._

## Assumptions

- This is stacked on `mmkal/26/05/24/hosted-connect-conflict-message`.
- This is an architecture-only change; hosted behavior, response status codes, and response bodies should stay byte-for-byte compatible where practical.
- The module interface should be small enough that future hosted safety checks can be added there without growing `CaptunServerShard.fetch`.

## Implementation Notes

- 2026-05-24: Nightly architecture pass recommended this because ownership-token safety policy is currently embedded in the Durable Object implementation, forcing integration setup for pure admission-policy cases.
