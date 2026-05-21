---
status: done
size: small
---

# Export Worker Module

Status summary: Done. The package now exposes a `captun/worker` subpath for source installs and published packages, and the compiled Worker declaration no longer depends on Captun's generated repo-local `Env` type.

## Assumptions

- `captun/worker` should expose the existing `src/worker.ts` module directly during local source usage.
- The published package should expose the compiled `dist/worker.js` and `dist/worker.d.ts` files for the same subpath.
- No new wrapper API is needed; consumers should get the current default Worker handler and `CaptunServerShard` export.

## Checklist

- [x] Add the `./worker` package export for source and published package manifests. _Implemented in `package.json` with source exports pointing at `src/worker.ts` and publish exports pointing at `dist/worker.js`/`dist/worker.d.ts`._
- [x] Build the package and confirm `dist/worker.js` and `dist/worker.d.ts` are emitted. _Verified with `pnpm build`; `dist/worker.d.ts` now declares the Captun Worker env shape directly._
- [x] Validate the packed/published manifest exposes `captun/worker`. _Verified with `pnpm pack --pack-destination ignoreme-pack` and `tar -xOf ignoreme-pack/captun-0.0.1.tgz package/package.json`._
- [x] Open a pull request so the `pkg-pr-new` job can produce an installable package for Iterate to test. _Opened https://github.com/iterate/captun/pull/14 after the task-spec commit._

## Implementation Notes

- 2026-05-22: User wants a smaller approach than threading `egressFetch` through the Iterate e2e stack. This package export should let Iterate deploy Captun's real Durable Object in its own stack and expose an internet-accessible tunnel URL for the MCP test server.
- 2026-05-22: `pnpm publish --dry-run --no-git-checks` ran `check`, `test`, and `prepack`, then failed only at registry validation because `captun@0.0.1` already exists.
