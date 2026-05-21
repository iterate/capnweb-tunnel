---
status: ready
size: medium
---

Summary: Add an opinionated browser-friendly mode for folder-routed tunnel hosts. Keep canonical path routing intact; cookie-rooting is only a happy-path convenience for root-relative apps like `npx serve`.

- [ ] Add a reserved tunnel selector route, e.g. `/__captun/t/:name`, that sets the active tunnel cookie and redirects to `/`.
- [ ] For folder-routed hosts, route root paths through the cookie-selected tunnel when present.
- [ ] Keep stateless `/name/...` routing working for direct links, curl, tests, and non-browser use.
- [ ] Do not let existing tunnel names dynamically steal root paths from a cookie-selected tunnel.
- [ ] Skip this behavior for subdomain-routed/custom-host tunnels where the hostname already carries tunnel identity.
- [ ] Strip Captun's routing cookie before forwarding to the local origin, and protect/cache responses appropriately.

## Notes

Subdomains are still the clean general solution. This task just makes the default `workers.dev` flow nicer without pretending path-prefix routing can be perfect.
