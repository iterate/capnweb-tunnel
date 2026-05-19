---
status: in-progress
size: medium
base_pr: 7
---

Summary: Stacked follow-up to the browser demo page. Move editable handler execution out of the first-party page context while preserving the no-build static docs demo and request/response logging.

- [ ] Run editable handler source in an isolated execution context instead of `Function(...)` in `docs/browser-demo.js`.
- [ ] Preserve support for handlers that return `Response`, string, `Blob`, `ReadableStream`, or `Uint8Array`.
- [ ] Preserve tunnel request logs, handler logs, and the built-in probe behavior.
- [ ] Surface compile/runtime errors clearly in the existing log and probe output UI.
- [ ] Keep the demo static and GitHub-Pages-friendly; do not add a bundler or app framework.
- [ ] Verify with syntax checks, repo checks, tests, and a local browser smoke where practical.

## Assumptions

- A dedicated Web Worker is enough isolation for this follow-up: it prevents handler code from touching the page DOM and local storage, while keeping web-standard `Request`/`Response` available.
- Stronger sandboxing, such as origin isolation or SES-style policy controls, can remain out of scope unless the static worker approach proves insufficient.
- This PR should use PR #7 as its base and stay focused on handler execution isolation.
