# Run: test-coverage-fixes

Executing [`test-coverage-fixes.plan.md`](test-coverage-fixes.plan.md), started 2026-08-22 at `4ebc284`.

- **1** 2026-08-22 — done. `schema.ts` format keywords → regex. `tsc` → 0; tests 91 pass; format-noise CLEAN.
- **2** 2026-08-22 — done. `move.ts` dest-stat catch classifies `FsError(NOT_FOUND)`. `tsc` → 0; tests 91 pass; move-noise CLEAN.
- **3** 2026-08-22 — done. `tools.test.ts` magic number → `ProtocolErrorCode.InvalidParams`. `tsc` → 0; `tools.test.ts` 9 pass.
- **4** 2026-08-22 — done. `helpers.ts` add `createStdioClient` + era-mirror comments. `tsc` → 0.
- **5** 2026-08-22 — done. `stdio.test.ts` created, STDIO-001/002 pass via real subprocess (~1.2s). Suite 91→93.
- **6** 2026-08-22 — done. `http-policy.test.ts` add `bearerAuthMiddleware` + TC-SEC-038/039/040. http-policy 20→23 pass.

## Done

- [x] `npx tsc -p tsconfig.json --noEmit` → exit 0
- [x] `node --test --import tsx "__tests__/**/*.test.ts"` → exit 0, 96 tests (91 + 2 stdio + 3 middleware)
- [x] format-noise → `CLEAN` (no `unknown format`)
- [x] move-noise → `CLEAN` (no `dest stat failed unexpectedly`)
- [x] `node scripts/tasks.mjs` → exit 0 (format, knip, type-check, lint, test, rebuild all green)
- [x] `git status` → 6 in-scope files only: `src/core/schema.ts`, `src/tools/move.ts`, `__tests__/tools.test.ts`, `__tests__/helpers.ts`, `__tests__/http-policy.test.ts` (modified) + `__tests__/stdio.test.ts` (new). `docs/` holds only this plan's artifacts.

## Deviations

- **Step 3 lint follow-up.** The literal→enum swap tripped `@typescript-eslint/no-unsafe-enum-comparison` (comparing a plain `number` field to an enum member). Fix: cast the field to the enum type (`{ code: ProtocolErrorCode }`) rather than `{ code: number }` — enum-to-enum comparison, lint-clean, same semantics. Not in the plan; smallest fix to the same line.
- **Prettier reformat.** `prettier --write` reordered the new imports (alphabetical) in `helpers.ts` and `http-policy.test.ts`. Mechanical; no semantic change.
