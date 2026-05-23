status: ready
size: small

# Hosted Connect Conflict Messages

Status summary: Spec is ready. Implementation should keep the stacked PR narrow: surface hosted WebSocket upgrade rejection details in library/CLI errors and avoid presenting DNS setup as the primary explanation for active-owner conflicts.

## Checklist

- [ ] Add a regression test for a rejected WebSocket upgrade body. _Pending; should show `createCaptunTunnel` callers see the Worker rejection text instead of only `WebSocket connection failed`._
- [ ] Improve library connect errors for pre-open WebSocket failures. _Pending; include deterministic status/body details when the runtime exposes them, or a clear hosted conflict message when it does not._
- [ ] Improve CLI tunnel connect messaging. _Pending; active-owner conflicts should mention the tunnel name is already connected or in use and should not lead with DNS hints._
- [ ] Run focused and full verification. _Pending; run focused tests plus `pnpm run check`, `pnpm test`, and `pnpm run build`._

## Notes

- This is stacked on `mmkal/26/05/24/hosted-ownership-tokens`.
- The target conflict body from the Worker is `Tunnel name is already connected`.
- Keep self-hosted DNS/certificate guidance for ordinary connection failures.

## Implementation Notes

- 2026-05-24: Created as a follow-up to the hosted ownership-token PR after review found anonymous active-owner conflicts were being reported as generic WebSocket/DNS failures.
