---
status: done
size: small
---

# Export Worker Module

Status summary: Done. The package now exposes a `captun/worker` subpath for source installs and published packages, and the compiled Worker declaration no longer depends on Captun's generated repo-local `Env` type.

## Assumptions

- `captun/worker` should expose the Captun Worker module directly during local source usage. After the 2026-05-27 source layout refactor it lives at `src/server/worker.ts`.
- The published package should expose the compiled Worker files for the same subpath. After the 2026-05-27 source layout refactor they live at `dist/server/worker.js` and `dist/server/worker.d.ts`.
- No new wrapper API is needed; consumers should get the current default Worker handler and `CaptunServerShard` export.

## Checklist

- [x] Add the `./worker` package export for source and published package manifests. _Implemented in `package.json`; after the 2026-05-27 source layout refactor, source exports point at `src/server/worker.ts` and publish exports point at `dist/server/worker.js`/`dist/server/worker.d.ts`._
- [x] Build the package and confirm the compiled Worker files are emitted. _Verified with `pnpm build`; after the 2026-05-27 source layout refactor, `dist/server/worker.d.ts` declares the Captun Worker env shape directly._
- [x] Validate the packed/published manifest exposes `captun/worker`. _Verified with `pnpm pack --pack-destination ignoreme-pack` and `tar -xOf ignoreme-pack/captun-0.0.1.tgz package/package.json`._
- [x] Open a pull request so the `pkg-pr-new` job can produce an installable package for Iterate to test. _Opened https://github.com/iterate/captun/pull/14 after the task-spec commit._

## Implementation Notes

- 2026-05-22: User wants a smaller approach than threading `egressFetch` through the Iterate e2e stack. This package export should let Iterate deploy Captun's real Durable Object in its own stack and expose an internet-accessible tunnel URL for the MCP test server.
- 2026-05-22: `pnpm publish --dry-run --no-git-checks` ran `check`, `test`, and `prepack`, then failed only at registry validation because `captun@0.0.1` already exists.
- 2026-05-27: The source layout refactor moved the `captun/worker` source implementation to `src/server/worker.ts` and the published files to `dist/server/worker.js` and `dist/server/worker.d.ts`.
