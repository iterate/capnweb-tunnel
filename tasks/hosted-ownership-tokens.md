status: in-progress
size: medium

# Hosted Anonymous Tunnel Ownership Tokens

Status summary: Spec commit only. This PR should add an anonymous ownership token for hosted `captun.sh` tunnel connections so the first active client owns a tunnel name until it disconnects; implementation and tests are still pending.

## Checklist

- [ ] Add hosted-only ownership-token parsing to the tunnel connect path.
- [ ] Let the first successful hosted connection for a tunnel name claim its token while active.
- [ ] Let a reconnect with the same token replace its own active connection.
- [ ] Reject a different token with `409 Conflict` while the tunnel is already active.
- [ ] Keep self-hosted and secret-protected tunnel behavior compatible.
- [ ] Generate and send a client-side anonymous token for hosted CLI/API/browser clients.
- [ ] Cover the hosted ownership behavior with integration-style tests.
- [ ] Run the focused tests and full project checks.

## Notes

- Scope is intentionally narrower than authenticated accounts: this is only an eviction guard for anonymous hosted tunnels.
- Tokens do not identify users and do not grant paid/custom subdomain rights. They only prove that a reconnect is from the same anonymous client instance.
- The hosted path is `captun.sh`; self-hosted Workers should keep the existing "last connection wins" behavior unless they opt into equivalent behavior later.
