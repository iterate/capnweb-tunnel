---
status: complete
size: medium
---

# Runtime server adapters

**Status summary:** Complete on PR #3. Captun now has runtime-specific Bun, Deno, and Node server adapter entry points, the weather reporter app runs on all four server shapes, and Vitest covers Cloudflare/Miniflare plus Bun/Deno/Node subprocess servers. No scoped implementation pieces are missing.

## Goal

Captun should support the weather-reporter pattern outside Cloudflare Workers. The Cloudflare path can keep using `WebSocketPair`/Durable Objects, but Bun, Deno, and Node need server-side adapters for their different HTTP upgrade shapes so examples can accept a Captun tunnel and forward `/weather` egress through it.

## Acceptance checklist

- [x] Add a small adapter concept around accepting server WebSocket upgrades while keeping the Cap'n Web tunnel session logic in shared code. _`src/server-core.ts` owns the shared remote-client-to-tunnel wrapper; `captun/bun`, `captun/deno`, and `captun/node` expose runtime-specific accept helpers._
- [x] Preserve the existing Cloudflare Worker/Durable Object weather example and test behavior. _`examples/weather-reporter/worker.ts` now delegates weather logic to `app.ts`, and the existing Miniflare weather test still passes._
- [x] Add a Bun weather reporter example and Vitest coverage that starts `Bun.serve` in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`. _`examples/weather-reporter/bun.ts` plus `bun.e2e.test.ts` cover the Bun subprocess._
- [x] Add a Deno weather reporter example and Vitest coverage that starts a Deno server in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`. _`examples/weather-reporter/deno.ts` plus `deno.e2e.test.ts` cover the Deno subprocess._
- [x] Add a Node weather reporter example and Vitest coverage that starts a Node server in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`. _`examples/weather-reporter/node.ts` plus `node.e2e.test.ts` cover the Node subprocess._
- [x] Keep the Bun/Node/Deno tests shaped similarly to `examples/weather-reporter/e2e.test.ts`; runtime-specific differences should live in fixtures or adapter calls, not in the assertions. _The three runtime tests share the same assertion flow and only vary the runtime fixture argument._
- [x] Run everything from Vitest. It is acceptable for tests to pay subprocess startup cost. _`runtime-fixtures.ts` starts Bun, Deno, and Node servers from Vitest-managed subprocesses._
- [x] Document the new adapter/example entry points enough that a reader can choose the Cloudflare, Bun, Deno, or Node shape. _Updated the root README API notes and the weather example README runtime list._
- [x] Verify with focused example tests plus the package typecheck/test command. _Ran `pnpm exec vitest run examples/weather-reporter/bun.e2e.test.ts examples/weather-reporter/deno.e2e.test.ts examples/weather-reporter/node.e2e.test.ts`, `pnpm run build`, `pnpm test`, `pnpm run check`, and `pnpm --filter @captun/weather-reporter test`._

## Implementation notes

- 2026-05-19: Created this task in a dedicated worktree from `mmkal/26/05/18/tweaks` on branch `mmkal/26/05/19/runtime-adapters`.
- 2026-05-19: Opened draft PR #3 after the spec commit, then implemented the runtime adapters and subprocess-backed weather tests.
- 2026-05-19: CI initially failed because the GitHub Node runner did not have `bun` or `deno` installed; added explicit setup steps for both runtimes and made fixture spawn errors report cleanly.
- 2026-05-19: Review feedback called out that the PR body example referenced non-existent `app.*` methods and made Bun look unlike the Cloudflare accept flow. Reworked the Bun adapter to `createCaptunBunTunnelHandler().accept(...)` plus a `websocket` handler, and changed the runtime examples to use local `let egressTunnel` variables.
- 2026-05-19: Follow-up review asked for the examples to keep the original weather reporter ordering. Updated Cloudflare/Bun/Deno/Node examples so `/weather` appears before `/__intercept-egress-traffic`, switched the runtime egress helpers to `const egressFetch: typeof fetch = ...`, and expanded the PR body with Cloudflare, Bun, Deno, and Node snippets that match the example files.
- 2026-05-19: Verification passed:
  - `pnpm exec tsc -p tsconfig.json --noEmit`
  - `pnpm exec vitest run examples/weather-reporter/bun.e2e.test.ts examples/weather-reporter/deno.e2e.test.ts examples/weather-reporter/node.e2e.test.ts`
  - `pnpm run build`
  - `pnpm test`
  - `pnpm run check`
  - `pnpm --filter @captun/weather-reporter test`
