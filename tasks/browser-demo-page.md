---
status: in-progress
size: medium
---

Summary: Spec fleshed out for bedtime implementation. Build a static, GitHub-Pages-friendly demo page that lets someone create a Captun tunnel from the browser by editing a fetch handler in a textarea, without introducing a framework or build step.

- [ ] Add a static demo page under `docs/` that can be served by GitHub Pages or opened locally.
- [ ] Let the user enter a Captun server URL, tunnel name, optional bearer secret, and fetch handler source.
- [ ] Use the browser session to create a real tunnel and expose the public tunnel URL when connected.
- [ ] Provide a sensible default handler that returns JSON/text so the demo is useful immediately.
- [ ] Show connection, request, response, and error logs in the page without requiring devtools.
- [ ] Document how to open/use the demo from `README.md`.
- [ ] Avoid adding a new app framework, bundler, or deployment dependency for this task.

## Assumptions

- The first version can depend on the published Captun browser entrypoint or a CDN import, but the page should make that dependency obvious in the source.
- Browser WebSocket clients cannot send arbitrary headers, so bearer auth should be handled only if the selected browser/runtime import path supports it; otherwise the UI should explain that browser demos need a non-secret demo Worker.
- The page is a product demo/tool, not a marketing landing page. The first screen should be the runnable tunnel controls.

## Notes

Original prompt: "We could probably have a github-pages page which shows a tunnel from a browser session. Write a fetch handler in a textarea, and that can start serving real http requests."
