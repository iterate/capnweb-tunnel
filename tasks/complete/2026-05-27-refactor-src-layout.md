---
status: done
size: medium
---

# Refactor `src/` Layout

Status summary: Done. The root library surface lives directly in `src/index.ts`, Runtime Adapters and the Cloudflare Tunnel Gateway live under `src/server`, and hosted-only product policy lives under `src/hosted`.

- [x] Keep the public root library code in `src/index.ts`. _Merged the temporary `src/lib/index.ts`, `src/lib/fetcher-capability.ts`, `src/lib/routing.ts`, and `src/lib/token.ts` modules back into `src/index.ts`._
- [x] Move Runtime Adapters and the Cloudflare Tunnel Gateway worker implementation into `src/server`. _Moved `node.ts`, `bun.ts`, `deno.ts`, and `worker.ts` under `src/server`; package subpath exports now point there._
- [x] Keep hosted app and CLI code under `src/hosted` and `src/cli`. _No hosted or CLI files moved out of their existing folders; imports were updated to the new root/server paths._
- [x] Retarget the import-boundary lint rule to the root library surface. _Replaced `captun/lib-import-boundary` with built-in `no-restricted-imports`, kept strict root-library defaults, and disabled it for `src/cli`, `src/server`, `src/hosted`, `src/worker`, tests, scripts, and examples._
- [x] Update package exports, deployment config, tests, docs, and generated browser module paths. _Updated `package.json`, `wrangler.jsonc`, Miniflare fixtures, README links, Deno import map, deploy worker path, and regenerated `src/hosted/browser-module.generated.ts`._
- [x] Verify typecheck, lint, build, and tests. _Verified with `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, `pnpm run build`, and `pnpm test`._

## Implementation Notes

- Started from a clean `main` worktree.
- Domain notes confirm Fetcher Capability primitives are library-facing, while Cloudflare Tunnel Gateway code should be separate from hosted product code.
- Kept the shared gateway protocol constants in `src/index.ts` because they are part of the root client API surface and are consumed by the Cloudflare Tunnel Gateway, hosted service, and CLI.
- Moved the broad product/control-plane reserved-name list to `src/hosted`; `src/server/worker.ts` only reserves `captun` and `gateway` for custom-domain self-hosted deployments where those labels can collide with the gateway hostname.
- Moved Tunnel Gateway addressing helpers to `src/server/tunnel-addressing.ts`; the remaining gateway connect constants now live in `src/index.ts`.
- Moved Node, Bun, and Deno adapters to `src/server` after clarifying that exported package subpaths are not the same as the root `captun` library surface.
- `createCaptunTunnel` now always sends a client-side token when none is supplied, but returns only the gateway-confirmed `ready` payload. The CLI reuses one generated token across retries for any gateway.
