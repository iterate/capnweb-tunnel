---
status: ready
size: medium
---

# Runtime server adapters

**Status summary:** Just specified. The goal is to keep Captun's tunnel core runtime-neutral while adding enough server adapter surface and weather-style examples to prove Bun, Deno, and Node can all host the same egress-intercepting app from Vitest. Implementation and verification are still missing.

## Goal

Captun should support the weather-reporter pattern outside Cloudflare Workers. The Cloudflare path can keep using `WebSocketPair`/Durable Objects, but Bun, Deno, and Node need server-side adapters for their different HTTP upgrade shapes so examples can accept a Captun tunnel and forward `/weather` egress through it.

## Acceptance checklist

- [ ] Add a small adapter concept around accepting server WebSocket upgrades while keeping the Cap'n Web tunnel session logic in shared code.
- [ ] Preserve the existing Cloudflare Worker/Durable Object weather example and test behavior.
- [ ] Add a Bun weather reporter example and Vitest coverage that starts `Bun.serve` in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`.
- [ ] Add a Deno weather reporter example and Vitest coverage that starts a Deno server in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`.
- [ ] Add a Node weather reporter example and Vitest coverage that starts a Node server in a subprocess, connects `createCaptunTunnel()`, intercepts `wttr.in`, and verifies `/weather?city=...`.
- [ ] Keep the Bun/Node/Deno tests shaped similarly to `examples/weather-reporter/e2e.test.ts`; runtime-specific differences should live in fixtures or adapter calls, not in the assertions.
- [ ] Run everything from Vitest. It is acceptable for tests to pay subprocess startup cost.
- [ ] Document the new adapter/example entry points enough that a reader can choose the Cloudflare, Bun, Deno, or Node shape.
- [ ] Verify with focused example tests plus the package typecheck/test command.

## Implementation notes

- 2026-05-19: Created this task in a dedicated worktree from `mmkal/26/05/18/tweaks` on branch `mmkal/26/05/19/runtime-adapters`.
