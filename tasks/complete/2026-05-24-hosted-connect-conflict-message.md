status: complete
size: small

# Hosted Connect Conflict Messages

Status summary: Complete and locally verified. `createCaptunTunnel` now surfaces deterministic HTTP rejection details when available, and the CLI treats hosted active-owner conflicts as name-in-use errors instead of DNS setup failures.

## Checklist

- [x] Add a regression test for a rejected WebSocket upgrade body. _`test/worker.test.ts` covers a 409 connect rejection and asserts `createCaptunTunnel` reports `Tunnel name is already connected`._
- [x] Improve library connect errors for pre-open WebSocket failures. _`src/index.ts` now probes the connect URL after a pre-open WebSocket error and throws `CaptunTunnelConnectError` with status/body details when the server exposes them._
- [x] Improve CLI tunnel connect messaging. _`src/cli/bin.ts` detects 409/name-in-use connect failures and prints an active anonymous client explanation instead of DNS guidance._
- [x] Run focused and full verification. _Verified with focused Vitest files, `pnpm run check`, `pnpm test`, and `pnpm run build`._

## Notes

- This is stacked on `mmkal/26/05/24/hosted-ownership-tokens`.
- The target conflict body from the Worker is `Tunnel name is already connected`.
- Keep self-hosted DNS/certificate guidance for ordinary connection failures.

## Implementation Notes

- 2026-05-24: Created as a follow-up to the hosted ownership-token PR after review found anonymous active-owner conflicts were being reported as generic WebSocket/DNS failures.
- 2026-05-24: Node's WebSocket `ErrorEvent` does not expose the rejected upgrade status/body directly, so the library performs a follow-up `fetch` to the same connect URL. This is deterministic for the hosted Worker conflict because the Worker returns `409` before creating the WebSocket upgrade response.
