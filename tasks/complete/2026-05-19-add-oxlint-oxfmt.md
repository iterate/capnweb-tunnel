---
status: complete
size: medium
---

Summary: Done. oxlint/oxfmt are installed with Captun-scoped scripts/config, existing files pass formatting/linting, and a local oxlint JS plugin now enforces the practical test-file preferences from the project instructions. Follow-up PR review comments tightened the custom rule scoping and naming. Verified lint, format, typecheck, and tests.

- [x] Add `oxlint` and `oxfmt` dev dependencies and root scripts for format/lint/fix workflows. _Implemented in `package.json` with `format`, `format:check`, `lint`, `lint:check`, and `lint:fix` scripts._
- [x] Add an oxlint configuration based on `../iterate`, scoped down for Captun's current package shape. _Added `.oxlintrc.json` with Iterate-style categories-off correctness rules and Captun ignores._
- [x] Make existing source/tests pass oxlint and oxfmt with minimal product-code churn. _Ran `oxfmt` and added a comment to the intentionally ignored JSON parse failure in `scripts/benchmark-startup.ts`._
- [x] In a separate follow-up commit, add a local oxlint JS plugin for test-file style preferences. _Added `oxlint-plugin-captun.js` and enabled it through `.oxlintrc.json`._
- [x] Enforce the test-file preferences that are practical to check statically: no lifecycle hooks, no `describe` wrappers, no `vi.mock`, helper functions below the tests, and object-level assertions over property-level `toBe` checks. _Implemented five `captun/*` rules and adjusted existing response assertions to match the new object-level style._
- [x] Verify `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, and `pnpm test`. _All pass locally; `pnpm test` reports 4 files and 30 tests passing._

## Assumptions

- "Base on `../iterate`" means use the sibling `iterate` repo's `package.json`, `.oxlintrc.json`, and JS-plugin structure as the reference, not a Git base branch.
- The first implementation commit should only add and wire oxlint/oxfmt. The custom plugin should be a second implementation commit after the tooling is already working.
- The custom plugin should prefer focused, reliable lint rules over broad prose-style checks that would create noisy false positives.

## Implementation Notes

- 2026-05-19: Added baseline tooling using `../iterate` as the reference. `pnpm run lint:check` and `pnpm run format:check` pass before adding the custom plugin.
- 2026-05-19: Added `captun-test` oxlint plugin and a Vitest spec that verifies the bad-pattern fixture reports all five custom rule codes.
- 2026-05-19: Follow-up review pass narrowed the property assertion rule to avoid `.length` and computed properties, caught `vi.doMock`, and made helper ordering check all tests rather than just the first.
- 2026-05-20: Addressed PR review comments by renaming the local plugin to `oxlint-plugin-captun.js`, using oxlint override globs to scope the custom rules to tests, switching the rule prefix to `captun`, and preventing method names like `suite.beforeEach()` or `database.mock()` from being treated as Vitest globals.
