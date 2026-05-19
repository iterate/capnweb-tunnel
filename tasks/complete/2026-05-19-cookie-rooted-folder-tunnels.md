---
status: complete
size: medium
---

Summary: Done. Folder-routed browser hosts now support a reserved selector route that sets a short-lived active tunnel cookie, root-relative browser requests route through that selected tunnel, direct stateless paths still work when no cookie is present, tunnel connect paths remain direct, and subdomain-routed hosts bypass the selector behavior. Review follow-up also protects cache correctness for no-cookie folder responses and prevents origins from mutating Captun's reserved routing cookie.

- [x] Add a reserved tunnel selector route, e.g. `/__captun/t/:name`, that sets the active tunnel cookie and redirects to `/`. _Implemented in `src/worker-routing.ts` and `src/worker.ts` via `select-active-tunnel` routing and a 302 root redirect._
- [x] For folder-routed hosts, route root paths through the cookie-selected tunnel when present. _Implemented by `captunRequestRouteParts`, which chooses the active tunnel cookie before folder path parsing for normal root paths._
- [x] Keep stateless `/name/...` routing working for direct links, curl, tests, and non-browser use. _Preserved `captunRouteParts` and covered no-cookie direct folder routing in `test/worker.test.ts`._
- [x] Do not let existing tunnel names dynamically steal root paths from a cookie-selected tunnel. _Covered by routing `/other/hello` through the selected `demo` tunnel when the active cookie is present._
- [x] Skip this behavior for subdomain-routed/custom-host tunnels where the hostname already carries tunnel identity. _Selector-looking paths on `demo.tunnels.example.com` are forwarded to the `demo` tunnel instead of setting cookies._
- [x] Strip Captun's routing cookie before forwarding to the local origin, and protect/cache responses appropriately. _Forwarding removes `__captun_active_tunnel` while preserving origin cookies; folder-host tunnel responses add `Vary: Cookie`, selector redirects are `Cache-Control: no-store`, and forwarded origin responses cannot set Captun's reserved routing cookie._
- [x] Add worker-routing unit coverage and end-to-end Worker tests for selector, cookie forwarding, direct paths, and subdomain bypass. _Added focused pure routing and Miniflare Worker coverage in `test/worker.test.ts`._

## Assumptions

- The cookie is host scoped, `HttpOnly`, `Secure` when the request is HTTPS, `SameSite=Lax`, and `Max-Age=3600`.
- Cookie-rooting only applies on folder-routed base hosts such as workers.dev/custom apex domains where the tunnel identity is normally the first path segment.
- Reserved Captun root paths are handled before tunnel dispatch. Tunnel-specific connect paths like `/name/__captun-connect` remain direct so clients can connect while a browser has an active tunnel cookie.

## Implementation Notes

- `captunRouteParts` remains the stateless hostname/path splitter used by the Durable Object and direct routing tests.
- `captunRequestRouteParts` is the Worker-facing router that handles selector paths, cookie-rooted paths, direct connect paths, and subdomain bypass.
- Top-level Worker dispatch strips Captun's routing cookie before sending requests to the Durable Object, so the local origin only sees its own cookies.
- 2026-05-20 review follow-up: no-cookie direct folder tunnel responses now also get `Vary: Cookie`, because the same URL can route differently when the active tunnel cookie is present. Forwarded tunnel responses now strip any origin `Set-Cookie` entries for `__captun_active_tunnel` while preserving unrelated origin cookies.
- Verification run:
  - `pnpm test:unit`
  - `pnpm run typecheck`
  - `pnpm test`
