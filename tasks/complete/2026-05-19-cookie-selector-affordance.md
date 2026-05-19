---
status: complete
size: small
base_pr: 6
---

Summary: Done. The CLI now prints the browser-root selector URL for folder-routed servers, README documents the `/__captun/t/:name` behavior, and subdomain-routed patterns are skipped.

- [x] Document the selector URL behavior in the CLI/custom host docs. _Added the folder-routed browser convenience flow to the Advanced CLI Usage section._
- [x] When `captun tunnel` starts against a folder-routed server URL, print the browser root URL alongside the canonical tunnel URL. _Added `tunnelBrowserRootUrl` in `src/bin.ts` and print it after the canonical tunnel line._
- [x] Avoid suggesting selector URLs for subdomain-routed/custom-host tunnel patterns where hostname routing already identifies the tunnel. _The helper returns `undefined` for `{name}` server URL patterns and fixed `*.tunnels.*`-style hostnames._
- [x] Verify typecheck and tests. _`pnpm run typecheck` and `pnpm test` pass locally._

## Assumptions

- This PR should be stacked on PR #6 and should not change the routing behavior itself.
- The CLI can infer selector support from the configured server URL shape in the same spirit as its existing `tunnelUrl` helper.

## Implementation Notes

- 2026-05-19: Kept this as a display/docs affordance only. Routing semantics stay in PR #6.
