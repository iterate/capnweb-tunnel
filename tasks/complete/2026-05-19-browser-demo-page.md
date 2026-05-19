---
status: done
size: medium
---

Summary: Spec fleshed out for bedtime implementation. Build a static, GitHub-Pages-friendly demo page that lets someone create a Captun tunnel from the browser by editing a fetch handler in a textarea, without introducing a framework or build step.

Status summary: Done. The static docs demo can connect a browser session to a Captun Worker, expose the public tunnel URL, handle probe requests with the editable fetch handler, and show connection/request/response/error logs. Local verification passed through repository checks and a browser smoke test against a local Worker.

- [x] Add a static demo page under `docs/` that can be served by GitHub Pages or opened locally. _Implemented as `docs/browser-demo.html`, `docs/browser-demo.css`, `docs/browser-demo.js`, and a tiny docs-side browser client._
- [x] Let the user enter a Captun server URL, tunnel name, optional bearer secret, and fetch handler source. _The tunnel form includes all four fields; the secret field shows the browser WebSocket limitation when populated._
- [x] Use the browser session to create a real tunnel and expose the public tunnel URL when connected. _`docs/browser-demo.js` calls the browser client and fills the public URL controls after the WebSocket session opens._
- [x] Provide a sensible default handler that returns JSON/text so the demo is useful immediately. _The default textarea handler returns JSON and handles CORS preflights for the built-in probe._
- [x] Show connection, request, response, and error logs in the page without requiring devtools. _The log panel records connection events, inbound tunnel requests, handler responses, probe responses, and errors._
- [x] Document how to open/use the demo from `README.md`. _Added a Browser demo section with static server instructions and the bearer-secret limitation._
- [x] Avoid adding a new app framework, bundler, or deployment dependency for this task. _The demo is plain HTML/CSS/scripts and lazy-loads only pinned `capnweb@0.8.0` from a CDN in the browser support module._

## Assumptions

- The first version can depend on the published Captun browser entrypoint or a CDN import, but the page should make that dependency obvious in the source.
- Browser WebSocket clients cannot send arbitrary headers, so bearer auth should be handled only if the selected browser/runtime import path supports it; otherwise the UI should explain that browser demos need a non-secret demo Worker.
- The page is a product demo/tool, not a marketing landing page. The first screen should be the runnable tunnel controls.

## Notes

Original prompt: "We could probably have a github-pages page which shows a tunnel from a browser session. Write a fetch handler in a textarea, and that can start serving real http requests."

## Implementation Log

- Added the static docs demo and README usage notes.
- `node --check docs/browser-demo.js && node --check docs/browser-demo-client.js` passed.
- `pnpm run check` passed.
- `pnpm test` passed with 29 tests across 3 files.
- Served `docs/` with `python3 -m http.server 8080 --bind 127.0.0.1 --directory docs`.
- Started a local Captun Worker on `http://localhost:8788` after `8787` was already in use.
- Browser smoke test connected the demo to `http://127.0.0.1:8788`, exposed `http://127.0.0.1:8788/fresh-bridge-2ro4t7`, sent the built-in `/health` probe, and received `200 OK` JSON from the browser fetch handler.
- Mobile viewport check at 390x844 showed the tool controls stacking cleanly.
- Browser automation could not navigate to a `file://` URL, so local browser verification used the static HTTP server path.
- Follow-up review pass added no-secret Worker deployment docs, an explicit trusted-code warning for the editable handler, clearer public URL labeling, and wider log kind spacing.
