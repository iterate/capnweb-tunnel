---
status: done
size: medium
base_pr: 7
---

Summary: Stacked follow-up to the browser demo page. Move editable handler execution out of the first-party page context while preserving the no-build static docs demo and request/response logging.

Status summary: Done. Editable handler compilation and execution now happen in a static dedicated Web Worker, while the main page keeps the tunnel/probe/log UI. Response normalization, handler logs, compile errors, and the built-in probe were verified against a local Wrangler Worker.

- [x] Run editable handler source in an isolated execution context instead of `Function(...)` in `docs/browser-demo.js`. _Added `docs/browser-demo-handler-worker.js`; `docs/browser-demo.js` now serializes requests into the worker and reconstructs worker-normalized responses._
- [x] Preserve support for handlers that return `Response`, string, `Blob`, `ReadableStream`, or `Uint8Array`. _The worker normalizes those return types to `Response`, buffers the body across the worker boundary, and the browser smoke exercised all five supported shapes._
- [x] Preserve tunnel request logs, handler logs, and the built-in probe behavior. _The main page still records tunnel/probe request and response rows; worker `context.log()` messages post back as handler log rows._
- [x] Surface compile/runtime errors clearly in the existing log and probe output UI. _Worker errors are serialized with their error name/message and shown through the existing `Handler did not compile` and handler error paths._
- [x] Keep the demo static and GitHub-Pages-friendly; do not add a bundler or app framework. _The sandbox is a plain static worker script loaded next to the existing HTML/CSS/JS assets._
- [x] Verify with syntax checks, repo checks, tests, and a local browser smoke where practical. _Ran `node --check`, `pnpm run check`, `pnpm test`, a direct worker browser smoke, and a full local Worker probe smoke._

## Assumptions

- A dedicated Web Worker is enough isolation for this follow-up: it prevents handler code from touching the page DOM and local storage, while keeping web-standard `Request`/`Response` available.
- Stronger sandboxing, such as origin isolation or SES-style policy controls, can remain out of scope unless the static worker approach proves insufficient.
- This PR should use PR #7 as its base and stay focused on handler execution isolation.

## Implementation Log

- Added `docs/browser-demo-handler-worker.js` as the static worker that compiles editable handler source, builds a worker-side `Request`, normalizes supported handler return types, and posts serialized responses/errors/logs back to the page.
- Updated `docs/browser-demo.js` to validate handler source via the worker before connecting and to execute each tunnel request in a fresh worker instance with a 30-second no-response guard.
- Updated the handler notice in `docs/browser-demo.html` to describe worker execution rather than first-party page execution.
- `node --check docs/browser-demo.js`, `node --check docs/browser-demo-client.js`, and `node --check docs/browser-demo-handler-worker.js` passed.
- `pnpm run check` passed after installing dependencies from the existing lockfile.
- `pnpm test` passed with 29 tests across 3 files.
- Browser smoke served `docs/` on `http://127.0.0.1:8765/browser-demo.html`; direct worker calls returned expected bodies for `Response`, string, `Blob`, `Uint8Array`, and `ReadableStream`, and confirmed handler code sees `document`/`localStorage` as `undefined`.
- Browser compile-error smoke set invalid handler source and confirmed the existing status/log UI reported `Handler did not compile` with a `SyntaxError`.
- Full local probe smoke ran `pnpm exec wrangler dev --ip 127.0.0.1 --port 8788`, connected the demo to `http://127.0.0.1:8788/browser-smoke`, sent the built-in `/health` probe, and received `200 OK` JSON through the browser handler with request/handler/response log rows.
