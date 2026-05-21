---
status: in-progress
size: small
---

# Export Worker Module

Status summary: Spec drafted; implementation not started. The goal is to expose a `captun/worker` package subpath that downstream Cloudflare stacks can import as the Captun Worker entrypoint and Durable Object definition.

## Assumptions

- `captun/worker` should expose the existing `src/worker.ts` module directly during local source usage.
- The published package should expose the compiled `dist/worker.js` and `dist/worker.d.ts` files for the same subpath.
- No new wrapper API is needed; consumers should get the current default Worker handler and `CaptunServerShard` export.

## Checklist

- [ ] Add the `./worker` package export for source and published package manifests.
- [ ] Build the package and confirm `dist/worker.js` and `dist/worker.d.ts` are emitted.
- [ ] Validate the packed/published manifest exposes `captun/worker`.
- [ ] Open a pull request so the `pkg-pr-new` job can produce an installable package for Iterate to test.

## Implementation Notes

- 2026-05-22: User wants a smaller approach than threading `egressFetch` through the Iterate e2e stack. This package export should let Iterate deploy Captun's real Durable Object in its own stack and expose an internet-accessible tunnel URL for the MCP test server.
