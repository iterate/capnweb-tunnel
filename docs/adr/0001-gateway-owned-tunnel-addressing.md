# Gateway-Owned Tunnel Addressing

Captun clients should connect to a user-supplied `gateway` URL with Captun-owned query parameters for connect intent, tunnel name, and token; they should not construct public tunnel URLs or dial a magic `/__captun-connect` path. The Tunnel Gateway owns Tunnel Addressing and returns the active Tunnel's public URL and reusable token over the Cap'n Web session before `createCaptunTunnel` resolves.

## Consequences

- The public API can use one address concept: `gateway`.
- `serverUrl`, `url`, and `/__captun-connect` are legacy implementation shapes to remove before the pre-user API hardens.
- Custom-domain deployments need a stable gateway hostname inside the wildcard route by default, with that hostname reserved as a Tunnel Name.
- Gateway Policy must be configured explicitly; it must not be inferred from hostname or addressing mode.
