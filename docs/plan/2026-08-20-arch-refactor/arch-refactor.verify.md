# Verification: arch-refactor

Against [`arch-refactor.spec.md`](arch-refactor.spec.md), commit `eb0502f`, 2026-08-20.

| ID  | Verdict | Observation                                                                                                                                                                                        | Evidence                                                                                                                                                                         |
| --- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | met     | shared `StoppedReason`/`StoppedReasonSchema`/`StopReasonTracker` live in `search.ts`; no per-tool `z.enum(['maxResults'...` remains                                                                | `grep -rn "enum(\['maxResults'" src/tools` → no hits; `search.ts:14,21`; full suite `node scripts/tasks.mjs` → `6/6 passed`                                                      |
| R2  | met     | `PathGuard.isEntryAccessible` exists; `glob.ts`'s `isEntryAccessibleByType` delegates to it; sensitive/out-of-bounds/symlink-escape entries still filtered                                         | `path.ts:558`; `glob.ts:29`; `__tests__/unit/path-guard.test.ts` new `isEntryAccessible` cases + `__tests__/unit/hunt-regressions.test.ts` skip/rethrow cases, all pass in `6/6` |
| R3  | met     | `resolveRealPath` exported from `path.ts`; `path-completer.ts` and `registrar.ts` call it instead of rolling their own realpath+normalize                                                          | `path.ts:261` (`export async function`); `path-completer.ts:12,114`; `registrar.ts:9,52`; `__tests__/unit/completions.test.ts:148` symlink-escape case passes                    |
| R5  | met     | `buildPatchDiff` in new `src/core/diff.ts`; both `edit.ts` and `replace-in-files.ts` call it; no `createTwoFilesPatch` left in `src/tools`                                                         | `diff.ts:8`; `edit.ts:426`; `replace-in-files.ts:401`; `grep -rn createTwoFilesPatch src/tools` → no hits                                                                        |
| R6  | met     | `isNotFoundErrno` added to `errors.ts`; all five `=== 'ENOENT'` literal sites in `path.ts`/`delete-file.ts` migrated; `glob.ts:60`'s `SKIPPABLE_ERRNOS` check correctly left alone (not a literal) | `errors.ts:329`; `grep -rn "=== 'ENOENT'" src/core/path.ts src/tools/delete-file.ts` → no hits; `glob.ts` ENOENT handling unchanged (already covered by `SKIPPABLE_ERRNOS`)      |

R4 not scored — dropped in plan-hunt (2026-08-20) before this implementation ran; recorded in spec's own R4 entry and `arch-refactor.plan.md` Notes.

## Unmet

None.

## Folded

None — no spec delta; the implementation matched the spec as written.
