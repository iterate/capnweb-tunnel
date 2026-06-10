---
status: in-progress
size: medium
---

# Send the Connect Token via Sec-WebSocket-Protocol instead of the URL

> Status: implementation in flight. Client transport, gateway parsing, subprotocol echo,
> and embedder helpers are the main pieces; hosted ownership-token flow keeps query-param
> back-compat.

Today `createCaptunTunnel` puts the **Connect Token** in a `?captun-token=` query
param. URLs are logged by default (Cloudflare request logs, logpush, exception
traces, anything that prints `request.url`), so any deployment that uses a
high-value **Gateway Secret** as its token leaks it into log storage. Flagged by
@jonastemplestein on iterate/iterate#1439 where the token was an admin-level
secret.

WebSocket clients can't set arbitrary headers (browsers especially), but they
_can_ offer subprotocols, and smuggling credentials through
`Sec-WebSocket-Protocol` is a well-established pattern (Kubernetes exec API,
graphql-ws, orpc's WS transport). Headers don't land in URL-shaped log fields.

## Design

- Client offers two subprotocols: `captun` (marker) and
  `captun-token.<base64url(token)>`. base64url because RFC 6455 subprotocol
  values must be HTTP token chars — base64url's `A-Za-z0-9-_` qualifies, and it
  lets tokens contain any characters.
- The gateway selects and echoes `captun` in the 101 response — mandatory,
  because browsers/undici/ws abort the handshake if the server doesn't pick an
  offered subprotocol. Never echo the token variant.
- Token resolution order on the server: subprotocol → `x-captun-connect-token`
  header → `captun-token` query param (back-compat for old clients and curl).
- The connect-rejection diagnostic probe (a plain `fetch`) sends the token via
  the `x-captun-connect-token` header so 401 diagnostics stay accurate without
  re-introducing the token into a URL.
- Embedders who call `acceptFetcherCapability` directly (e.g. iterate's project
  egress intercept DO) get the request passed in so the 101 echoes the
  subprotocol, plus an exported `connectTokenFromRequest(request)` to read the
  token wherever it was sent.

## Checklist

- [ ] Client: stop setting `captun-token` in the connect URL; send subprotocols on the WebSocket and the diagnostic-probe header instead
- [ ] Gateway worker + hosted worker: resolve tokens via shared `connectTokenFromRequest`
- [ ] `acceptFetcherCapability({ request })`: echo the `captun` subprotocol on the 101 when offered
- [ ] Hosted ownership-token charset: accept any printable-ASCII token up to 128 chars (tokens no longer need to be URL-safe)
- [ ] Tests: token-protected gateway over a real WebSocket handshake (proves the echo), wrong-token 401 diagnostics, query-param back-compat, subprotocol parsing edge cases
- [ ] Docs: README protocol notes + CONTEXT.md Connect Token section

## Compatibility

New client ↔ old gateway breaks (token moves out of the URL, and old gateways
don't echo the subprotocol). Acceptable at 0.0.x: the hosted gateway deploys
from this repo in lockstep, and self-hosted/embedded deployments pin client and
worker from the same package version. Old client ↔ new gateway keeps working
via the query-param fallback.
