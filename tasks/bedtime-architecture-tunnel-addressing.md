---
status: in-progress
size: medium
kind: bedtime-architecture
---

Summary: Architecture pass selected **Named Tunnel Addressing** as the highest-impact deepening opportunity. Current routing/addressing behavior is split across Worker routing, CLI tunnel URL construction, and tests; tonight's selector URL follow-up exposed real drift. This task will concentrate that behavior behind one small module interface.

- [ ] Add a named tunnel addressing module for folder/subdomain classification and public tunnel/connect URL construction.
- [ ] Move CLI tunnel URL construction to the addressing module instead of keeping private URL helpers in `src/bin.ts`.
- [ ] Keep Worker route parsing behavior unchanged while making the shared classification explicit.
- [ ] Add focused unit coverage for public URL and connect URL construction, including folder, path-prefixed folder, `{name}` template, and subdomain-style hosts.
- [ ] Update the PR body with replacement compare branches for the open bedtime PR queue.
- [ ] Verify with typecheck and tests.

## Architecture Decision

Candidate chosen: **Named Tunnel Addressing**.

Why this one:

- It has the best locality payoff for tonight's work. Cookie-rooted folder routing, browser demo URLs, and CLI output all need the same definition of "folder-routed" versus "subdomain-routed".
- It is small enough to land safely but deep enough to prevent future routing drift.
- It improves the interface test surface: callers can ask for public/connect URLs without reimplementing URL rules.

## Assumptions

- This PR should not change runtime behavior by itself; it should move behavior behind a deeper module.
- The new module can be source-level internal for now, exported only as needed inside the package.
- Broader deploy planning and Durable Object lifecycle seams are valid later candidates, but less directly connected to tonight's queue.
