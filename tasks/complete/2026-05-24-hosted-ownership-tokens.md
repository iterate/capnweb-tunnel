status: complete
size: medium

# Hosted Anonymous Tunnel Ownership Tokens

Status summary: Implementation is complete and locally verified. Hosted anonymous tunnel connections now require an ownership token, conflicting active owners get `409`, same-owner reconnects and CLI retries reuse one owner token, and self-hosted replacement behavior remains compatible.

## Checklist

- [x] Add hosted-only ownership-token parsing to the tunnel connect path. _`CaptunServerShard.fetch` now reads `captun-owner-token` or `x-captun-owner-token` only for anonymous `CUSTOM_HOSTNAME=captun.sh` connects._
- [x] Let the first successful hosted connection for a tunnel name claim its token while active. _Active shard entries now store the accepted owner token beside the Cap'n Web fetcher._
- [x] Let a reconnect with the same token replace its own active connection. _Same-token hosted connects still dispose and replace the previous active fetcher._
- [x] Reject a different token with `409 Conflict` while the tunnel is already active. _Different-token hosted connects return `Tunnel name is already connected` without touching the active tunnel._
- [x] Keep self-hosted and secret-protected tunnel behavior compatible. _Ownership enforcement is skipped outside hosted `captun.sh` and when `CAPTUN_SECRET` is configured; tests cover self-hosted replacement._
- [x] Generate and send a client-side anonymous token for hosted CLI/API/browser clients. _`createCaptunTunnel` appends a generated query token to the WebSocket URL, returns it on `tunnel.ownerToken`, accepts it back as `ownerToken`, CLI retry loops reuse one generated token, and `/captun.browser.js` follows the same shape._
- [x] Cover the hosted ownership behavior with integration-style tests. _`test/worker.test.ts` covers conflict, same-token replacement, header token parsing, missing-token rejection, client token generation/reuse, and self-hosted compatibility._
- [x] Run the focused tests and full project checks. _Verified with focused worker tests, full `pnpm test`, `pnpm run check`, and `pnpm run build`._

## Notes

- Scope is intentionally narrower than authenticated accounts: this is only an eviction guard for anonymous hosted tunnels.
- Tokens do not identify users and do not grant paid/custom subdomain rights. They only prove that a reconnect is from the same anonymous client instance.
- The hosted path is `captun.sh`; self-hosted Workers should keep the existing "last connection wins" behavior unless they opt into equivalent behavior later.

## Implementation Notes

- 2026-05-24: Tokens are intentionally passed on the connect request only, using a browser-compatible query parameter by default. The Worker also accepts an equivalent header for non-browser clients and tests.
- 2026-05-24: Review follow-up exposed `ownerToken` on the returned tunnel and added `ownerToken` as an explicit create option so exported API callers can exercise same-owner replacement without manually editing query strings.
- 2026-05-24: This does not persist ownership after disconnect. Once the active Cap'n Web session breaks, the tunnel name is free for another anonymous token to claim.
- 2026-05-24: Bugbot follow-up moved CLI retries to one owner token per tunnel session so a partially successful retry cannot conflict with its own previous attempt.
- 2026-05-24: Second Bugbot follow-up reused the library's exported `randomOwnershipToken` in the CLI instead of maintaining a duplicate token generator.
