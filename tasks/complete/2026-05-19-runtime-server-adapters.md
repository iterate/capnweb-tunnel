---
status: complete
size: medium
---

# Runtime server adapters

**Status summary:** Complete on PR #3. Captun now has runtime-specific Bun, Deno, and Node server adapter entry points, each runtime has a self-contained weather example, and Vitest covers Cloudflare/Miniflare plus Bun/Deno/Node subprocess servers. No scoped implementation pieces are missing.

## Goal

Captun should support the weather-reporter pattern outside Cloudflare Workers. The Cloudflare path can keep using `WebSocketPair`/Durable Objects, but Bun, Deno, and Node need server-side adapters for their different HTTP upgrade shapes so examples can accept a Captun tunnel and forward `/weather` egress through it.

## Acceptance checklist

- [x] Add a small adapter concept around accepting server WebSocket upgrades while keeping the Cap'n Web tunnel session logic in shared code. _`src/server-core.ts` owns the shared remote-client-to-tunnel wrapper; `captun/bun`, `captun/deno`, and `captun/node` expose runtime-specific accept helpers._
- [x] Preserve the existing Cloudflare Worker/Durable Object weather example and test behavior. _`examples/cloudflare/worker.ts` is self-contained again, and `examples/cloudflare/cloudflare.test.ts` covers the Miniflare path._
- [x] Add a Bun weather reporter example and Vitest coverage that starts `Bun.serve` in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`. _`examples/bun/server.ts` plus `examples/bun/bun.test.ts` cover the Bun subprocess._
- [x] Add a Deno weather reporter example and Vitest coverage that starts a Deno server in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`. _`examples/deno/server.ts` plus `examples/deno/deno.test.ts` cover the Deno subprocess._
- [x] Add a Node weather reporter example and Vitest coverage that starts a Node server in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`. _`examples/node/server.ts` uses `@whatwg-node/server` for the Fetch request adapter, while `examples/node/node.test.ts` covers the Node subprocess._
- [x] Keep the Bun/Node/Deno tests shaped similarly to the Cloudflare test; runtime-specific differences should live in local helper functions or adapter calls, not in the assertions. _Each runtime test keeps its startup helper at the bottom of that file and uses the same assertion flow._
- [x] Run everything from Vitest. It is acceptable for tests to pay subprocess startup cost. _The Bun, Deno, and Node test files start their own subprocesses from Vitest without a shared runtime fixture module._
- [x] Document the new adapter/example entry points enough that a reader can choose the Cloudflare, Bun, Deno, or Node shape. _Updated the root README API notes plus the PR body examples for the split `examples/bun`, `examples/node`, `examples/deno`, and `examples/cloudflare` folders._
- [x] Verify with focused example tests plus the package typecheck/test command. _Ran focused Bun/Node/Deno/Cloudflare example tests, `pnpm run build`, `pnpm test`, `pnpm run check`, and `pnpm --filter @captun/cloudflare-example test` after the folder split._

## Implementation notes

- 2026-05-19: Created this task in a dedicated worktree from `mmkal/26/05/18/tweaks` on branch `mmkal/26/05/19/runtime-adapters`.
- 2026-05-19: Opened draft PR #3 after the spec commit, then implemented the runtime adapters and subprocess-backed weather tests.
- 2026-05-19: CI initially failed because the GitHub Node runner did not have `bun` or `deno` installed; added explicit setup steps for both runtimes and made fixture spawn errors report cleanly.
- 2026-05-19: Review feedback called out that the PR body example referenced non-existent `app.*` methods and made Bun look unlike the Cloudflare accept flow. Reworked the Bun adapter to `createCaptunBunTunnelHandler().accept(...)` plus a `websocket` handler, and changed the runtime examples to use local `let egressTunnel` variables.
- 2026-05-19: Follow-up review asked for the examples to keep the original weather reporter ordering. Updated Cloudflare/Bun/Deno/Node examples so `/weather` appears before `/__intercept-egress-traffic`, switched the runtime egress helpers to `const egressFetch: typeof fetch = ...`, and expanded the PR body with Cloudflare, Bun, Deno, and Node snippets that match the example files.
- 2026-05-19: Follow-up review asked to remove the shared app module and shared runtime fixture. Split the example into `examples/bun`, `examples/node`, `examples/deno`, and `examples/cloudflare`; each server file now repeats the weather handler locally, and each runtime test keeps its process helper at the bottom of the test file.
- 2026-05-19: Follow-up review asked for the Node example to use a real Fetch adapter and for the runtime servers to avoid extra health endpoints. Switched Node to `@whatwg-node/server`, removed `/__health__` from Bun/Deno/Node, and changed the runtime test helpers to wait for the TCP listener instead.
- 2026-05-19: Adding `@whatwg-node/server` exposed the Worker's untyped `crypto.subtle.timingSafeEqual` usage during root typecheck. Replaced it with a small local byte comparison in `src/worker.ts`.
- 2026-05-19: Follow-up review asked to remove local Bun and Deno ambient declarations from the server examples. Added runtime-specific example typecheck setup instead: Bun uses `@types/bun`, Deno uses `deno check`, and the shared socket accept helper moved to `src/server-core.ts` so Deno does not need to typecheck Cloudflare's `WebSocketPair` route.
- 2026-05-19: Follow-up review questioned repeated runtime subpath type re-exports. Moved shared public types to the root `captun` export and removed `CaptunServerTunnel`/`CaptunServerAcceptTunnelOptions` re-exports from `captun/server`, `captun/bun`, `captun/deno`, and `captun/node`.
- 2026-05-19: Follow-up review asked why the Bun adapter was much larger than the Cap'n Web README example. Simplified `src/bun.ts` to wrap `newBunWebSocketRpcHandler()` instead of manually storing sessions and dispatching message/close/error events.
- 2026-05-19: Verification passed:
  - `pnpm exec tsc -p tsconfig.json --noEmit`
  - `pnpm exec vitest run examples/bun/bun.test.ts examples/node/node.test.ts examples/deno/deno.test.ts examples/cloudflare/cloudflare.test.ts`
  - `pnpm run build`
  - `pnpm test`
  - `pnpm run check`
  - `pnpm --filter @captun/cloudflare-example test`
