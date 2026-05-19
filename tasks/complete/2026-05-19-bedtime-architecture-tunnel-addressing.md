---
status: done
size: medium
kind: bedtime-architecture
---

Summary: Done. Named tunnel addressing now lives behind a shared module used by the CLI, Worker routing, and E2E helpers; replacement compare branches were pushed for the open PR queue and linked from the architecture PR body.

- [x] Add a named tunnel addressing module for folder/subdomain classification and public tunnel/connect URL construction. _Implemented in `src/tunnel-addressing.ts`._
- [x] Move CLI tunnel URL construction to the addressing module instead of keeping private URL helpers in `src/bin.ts`. _`captun tunnel` now calls `publicTunnelUrl()` and `tunnelConnectUrl()`._
- [x] Keep Worker route parsing behavior unchanged while making the shared classification explicit. _`captunRouteParts()` now imports `usesFolderRouting()` from the addressing module._
- [x] Add focused unit coverage for public URL and connect URL construction, including folder, path-prefixed folder, `{name}` template, and subdomain-style hosts. _Added named tunnel addressing cases in `test/worker.test.ts`._
- [x] Update the PR body with replacement compare branches for the open bedtime PR queue. _Pushed replacement branches for PRs #3-#9 and linked them in PR #10._
- [x] Verify with typecheck and tests. _Ran `pnpm run typecheck` and `pnpm test` in the architecture worktree._

## Architecture Decision

Candidate chosen: **Named Tunnel Addressing**.

Why this one:

- It has the best locality payoff for tonight's work. Cookie-rooted folder routing, browser demo URLs, and CLI output all need the same definition of "folder-routed" versus "subdomain-routed".
- It is small enough to land safely but deep enough to prevent future routing drift.
- It improves the interface test surface: callers can ask for public/connect URLs without reimplementing URL rules.

## Assumptions

- This PR should avoid product-facing churn, but the shared classifier should align CLI URL construction with Worker subdomain routing. That intentionally fixes the concrete custom-subdomain connect URL case that previously drifted from Worker routing.
- The new module can be source-level internal for now, exported only as needed inside the package.
- Broader deploy planning and Durable Object lifecycle seams are valid later candidates, but less directly connected to tonight's queue.
