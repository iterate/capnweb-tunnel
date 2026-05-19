---
status: in-progress
size: medium
---

Summary: Spec fleshed out for bedtime implementation. The intended behavior is a workers.dev/browser convenience only: visiting a reserved selector path should set an active tunnel cookie and redirect root-relative browser traffic to that tunnel, while canonical `/name/...` and subdomain routing stay unchanged.

- [ ] Add a reserved tunnel selector route, e.g. `/__captun/t/:name`, that sets the active tunnel cookie and redirects to `/`.
- [ ] For folder-routed hosts, route root paths through the cookie-selected tunnel when present.
- [ ] Keep stateless `/name/...` routing working for direct links, curl, tests, and non-browser use.
- [ ] Do not let existing tunnel names dynamically steal root paths from a cookie-selected tunnel.
- [ ] Skip this behavior for subdomain-routed/custom-host tunnels where the hostname already carries tunnel identity.
- [ ] Strip Captun's routing cookie before forwarding to the local origin, and protect/cache responses appropriately.
- [ ] Add worker-routing unit coverage and end-to-end Worker tests for selector, cookie forwarding, direct paths, and subdomain bypass.

## Assumptions

- The cookie should be host scoped, `HttpOnly`, `Secure` when the request is HTTPS, `SameSite=Lax`, and short enough lived to avoid surprising stale routing.
- Cookie-rooting should only apply on folder-routed base hosts such as workers.dev/custom apex domains where the tunnel identity is normally the first path segment.
- Reserved Captun paths should continue to be handled before tunnel dispatch.

## Notes

Subdomains are still the clean general solution. This task just makes the default `workers.dev` flow nicer without pretending path-prefix routing can be perfect.
