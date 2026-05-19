---
status: in-progress
size: small
base_pr: 6
---

Summary: Stacked follow-up to cookie-rooted folder routing. Make the reserved selector URL discoverable in CLI output and README docs so users can use root-relative browser apps without guessing `/__captun/t/:name`.

- [ ] Document the selector URL behavior in the CLI/custom host docs.
- [ ] When `captun tunnel` starts against a folder-routed server URL, print the browser root URL alongside the canonical tunnel URL.
- [ ] Avoid suggesting selector URLs for subdomain-routed/custom-host tunnel patterns where hostname routing already identifies the tunnel.
- [ ] Verify typecheck and tests.

## Assumptions

- This PR should be stacked on PR #6 and should not change the routing behavior itself.
- The CLI can infer selector support from the configured server URL shape in the same spirit as its existing `tunnelUrl` helper.
