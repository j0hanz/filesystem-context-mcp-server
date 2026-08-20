# Run: Cut dead code and stale comments surfaced by the src/tools QC review

Executing [`qc-tools-fixes.plan.md`](qc-tools-fixes.plan.md), started 2026-08-20 at `3e00223`.

- **1** 2026-08-20 — done. Removed unreachable `owned` flag, `if (owned) freeRegex(regex)`, and its comment in `findEditMatch` ([`edit.ts:192-204`](../../../src/tools/edit.ts#L192-L204)). `node scripts/tasks.mjs --quick` → 4/4 passed (2 skipped).
- **2** 2026-08-20 — done. Rewrote garbled `--- IGNORE ---` comment at [`read.ts:327`](../../../src/tools/read.ts#L327). `--quick` → 4/4 passed.
- **3** 2026-08-20 — done. Dropped dead `matchCount`/`fileCount` return fields + `new Set(...).size` computation from `handleSearchContent` ([`search-content.ts:349-397`](../../../src/tools/search-content.ts#L349-L397)). `--quick` → 4/4 passed.
- **4** 2026-08-20 — done. Dropped dead `count` return field from `handleSearchFiles` ([`search-files.ts:130,186,190`](../../../src/tools/search-files.ts#L130)). `--quick` → 4/4 passed.
- **5** 2026-08-20 — done. Tightened `PutResourceParams` to used fields; `buildLinkBlock` now takes `audienceParam?: Role[]` directly (title/description plumbing removed); `putResource` calls it with no audience (defaults `['user']`); `buildFileResourceLink` passes `['user','assistant']`. `--quick` → 4/4 passed (formatter collapsed the audience array to one line).
- **6** 2026-08-20 — done. Collapsed `toDeleteFailure` to the `ENOTEMPTY`/`EISDIR`/`EEXIST` override + single `Problem.fromUnknown(error, ErrorCode.UNKNOWN, path)` fallthrough ([`delete-file.ts:74-100`](../../../src/tools/delete-file.ts#L74-L100)). `node scripts/tasks.mjs` → 6/6 passed (delete-tool tests confirm `NOT_FOUND`/`PERMISSION_DENIED` codes survive).
- **7** 2026-08-20 — done. Removed the bare wrapping `{ ... }` block in `handleList` and de-indented the body ([`list.ts:263-311`](../../../src/tools/list.ts#L263-L311)). `--quick` → 4/4 passed.
- **8** 2026-08-20 — done. Deleted the stale JSDoc referencing the absent `result.structured as Record<string, unknown>` cast in `buildSuccessResponse` ([`define.ts:223-226`](../../../src/tools/define.ts#L223-L226)). `--quick` → 4/4 passed.

## Done

- [x] `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped)
- [x] `node scripts/tasks.mjs` → exit 0, 6/6 passed (format, knip, type-check, lint, rebuild, test), including `progress-session.test.ts`, `shared-resource-response.test.ts`, and the delete-tool tests
- [x] `git status` shows changes only in the eight in-scope files (`edit.ts`, `read.ts`, `search-content.ts`, `search-files.ts`, `_helpers.ts`, `delete-file.ts`, `list.ts`, `define.ts`); the only untracked entries are this run log, the plan, and the plan-hunt report under `docs/plan/2026-08-20-qc-tools-fixes/`
- [x] `git diff` shows no new behavior — net -42 lines (105 deletions, 63 insertions; the list.ts de-indent accounts for most of the insertion count as whitespace churn)

## Notes / deviations

- No STOP conditions tripped. No deviations from the plan.
- The three out-of-scope rejections held: `progress.ts` `#total`, `delete-file.ts` `handleDelete`, and `create.ts` were not touched (tested feature / output-shape mismatch / behavior change — see plan Scope).
- Review points flagged in the plan: step 5 (`buildLinkBlock` signature change — `audience` default `['user']` preserved, confirmed by `shared-resource-response.test.ts:19`) and step 6 (`toDeleteFailure` collapse — byte-identical via `ERRNO_MAP`, confirmed by the plan-hunt refuter and the delete-tool tests). Both green.

## Post-plan follow-ups (from the qc/bug-hunt review of the landed diff)

bug-hunt: no findings. qc: APPROVE, no regressions; two non-blocking missed
net-deletion moves raised. Both taken (in-scope files, cheap):

- **9** 2026-08-20 — done. Dropped dead `DeletedItem.type` field + the
  `type: itemType` assignment in `deleteSinglePath`'s return
  ([`delete-file.ts:60,251`](../../../src/tools/delete-file.ts#L60)). `itemType`
  stays — it drives the TOCTOU check. `handleDelete` only ever read `r.item.path`.
- **10** 2026-08-20 — done. Dropped dead `CollectResult.scannedEntries` field +
  its return line in `collect` ([`list.ts:56,153`](../../../src/tools/list.ts#L56)).
  No reader; the `scanned` local stays (feeds `onProgress` at
  [`list.ts:108`](../../../src/tools/list.ts#L108)).

`node scripts/tasks.mjs` → 6/6 passed. Final diff: 8 files, net -45 lines
(109 deletions, 64 insertions).
