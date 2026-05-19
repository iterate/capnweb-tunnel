---
status: in-progress
size: medium
---

Summary: About 10% done. The task has been specified and the implementation will follow the `../iterate` oxlint/oxfmt setup. Missing pieces are package setup, config, custom test-style rules, and CI-quality verification.

- [ ] Add `oxlint` and `oxfmt` dev dependencies and root scripts for format/lint/fix workflows.
- [ ] Add an oxlint configuration based on `../iterate`, scoped down for Captun's current package shape.
- [ ] Make existing source/tests pass oxlint and oxfmt with minimal product-code churn.
- [ ] In a separate follow-up commit, add a local oxlint JS plugin for test-file style preferences.
- [ ] Enforce the test-file preferences that are practical to check statically: no lifecycle hooks, no `describe` wrappers, no `vi.mock`, helper functions below the tests, and object-level assertions over property-level `toBe` checks.
- [ ] Verify `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`.

## Assumptions

- "Base on `../iterate`" means use the sibling `iterate` repo's `package.json`, `.oxlintrc.json`, and JS-plugin structure as the reference, not a Git base branch.
- The first implementation commit should only add and wire oxlint/oxfmt. The custom plugin should be a second implementation commit after the tooling is already working.
- The custom plugin should prefer focused, reliable lint rules over broad prose-style checks that would create noisy false positives.
