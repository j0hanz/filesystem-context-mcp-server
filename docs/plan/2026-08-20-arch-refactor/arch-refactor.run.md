# Run: Collapse six duplicated domain rules into their owning core modules

Executing [`arch-refactor.plan.md`](arch-refactor.plan.md), started 2026-08-20 at `eb0502f`.

- **1** 2026-08-20 — done. `node scripts/tasks.mjs` → `6/6 passed`. Deviation: `isNotFoundErrno` needed a type-guard return (`error is NodeJS.ErrnoException`), not plain `boolean`, to preserve narrowing at `path.ts:724`'s `error.message` use — plan's snippet used `boolean`.
- **2** 2026-08-20 — done. `node scripts/tasks.mjs` → `6/6 passed`. `buildDiff` in `edit.ts` only delegated, so inlined it at its single call site per the plan's own contingency.
- **3** 2026-08-20 — done. `node scripts/tasks.mjs` → `6/6 passed` after `FS_UPDATE_SCHEMA_SNAPSHOT=1`. Snapshot diff verified by structural JSON compare against `eb0502f`: only `find_files`/`search_text` `stoppedReason` enums gained `maxFiles`, nothing else — surrounding array-formatting churn in the diff is JSON pretty-printer noise, not content.
- **4** 2026-08-20 — done. `node scripts/tasks.mjs` → `6/6 passed`. No new unit test added — `__tests__/unit/completions.test.ts:148` ("does not enumerate completion entries through a linked directory outside allowed roots") already exercises `isAllowedCompletionDirectory`'s symlink-escape and containment path end-to-end through `PathCompleter`; adding a duplicate would just restate it. Neither R3 STOP clause fired.
- **5** 2026-08-20 — done. `node scripts/tasks.mjs` → `6/6 passed`. Deviation: `__tests__/unit/hunt-regressions.test.ts`'s two "list entry access" tests used a `fakeGuard` object typed `as unknown as PathGuard` implementing only `isSensitive`/`validateExistingPathDetailed` — not in the plan's Current-state or Scope — which broke at runtime once `isEntryAccessibleByType` became a pure delegate to `pathGuard.isEntryAccessible`. Fixed by adding an `isEntryAccessible` method to both fakes that replicates the real catch-and-classify logic (`isFsError` + `SKIPPABLE_FS_CODES`), preserving the skip-vs-rethrow assertion the tests exist to lock. R2's `this.isSensitive` name matched (no STOP); reviewer-focus items confirmed by inspection: non-symlink branch checks `bounds` not `this.rootBoundaries`, error branch stayed `SKIPPABLE_ERRNOS`/`SKIPPABLE_FS_CODES` (not rewritten to `isNotFoundErrno`).
- **6** 2026-08-20 — R4 not executed (dropped by plan-hunt before this run; recorded in spec Out-of-scope).

## Done

- [x] `node scripts/tasks.mjs --quick` exits 0 → `4/4 passed (2 skipped)`
- [x] `node scripts/tasks.mjs` exits 0 → `6/6 passed`
- [x] `git status` shows no files outside the in-scope list plus `src/core/diff.ts` and new/edited test files: 15 modified in-scope files, `src/core/diff.ts` (new), `__tests__/unit/diff.test.ts` (new), `__tests__/unit/search.test.ts` (new), `__tests__/unit/errors.test.ts`/`path-guard.test.ts`/`hunt-regressions.test.ts` (edited)
- [x] `grep -rn "enum(\['maxResults'" src/tools` → no hits
- [x] `grep -rn "=== 'ENOENT'" src/core/path.ts src/tools/delete-file.ts` → no hits
- [x] `grep -rn createTwoFilesPatch src/tools` → no hits
