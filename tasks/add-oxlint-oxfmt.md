---
status: in-progress
size: medium
---

Summary: About 60% done. oxlint/oxfmt are installed and wired with a Captun-scoped config based on `../iterate`; existing files have been formatted and the baseline lint check is clean. Missing pieces are the custom test-style plugin, full verification, and moving this task to complete.

- [x] Add `oxlint` and `oxfmt` dev dependencies and root scripts for format/lint/fix workflows. _Implemented in `package.json` with `format`, `format:check`, `lint`, `lint:check`, and `lint:fix` scripts._
- [x] Add an oxlint configuration based on `../iterate`, scoped down for Captun's current package shape. _Added `.oxlintrc.json` with Iterate-style categories-off correctness rules and Captun ignores._
- [x] Make existing source/tests pass oxlint and oxfmt with minimal product-code churn. _Ran `oxfmt` and added a comment to the intentionally ignored JSON parse failure in `scripts/benchmark-startup.ts`._
- [ ] In a separate follow-up commit, add a local oxlint JS plugin for test-file style preferences.
- [ ] Enforce the test-file preferences that are practical to check statically: no lifecycle hooks, no `describe` wrappers, no `vi.mock`, helper functions below the tests, and object-level assertions over property-level `toBe` checks.
- [ ] Verify `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`.

## Assumptions

- "Base on `../iterate`" means use the sibling `iterate` repo's `package.json`, `.oxlintrc.json`, and JS-plugin structure as the reference, not a Git base branch.
- The first implementation commit should only add and wire oxlint/oxfmt. The custom plugin should be a second implementation commit after the tooling is already working.
- The custom plugin should prefer focused, reliable lint rules over broad prose-style checks that would create noisy false positives.

## Implementation Notes

- 2026-05-19: Added baseline tooling using `../iterate` as the reference. `pnpm run lint:check` and `pnpm run format:check` pass before adding the custom plugin.
