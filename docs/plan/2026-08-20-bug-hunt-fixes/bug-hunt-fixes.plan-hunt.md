# Plan hunt — [`bug-hunt-fixes.plan.md`](bug-hunt-fixes.plan.md)

> Read-only adversarial pass. The hunter checks the plan against the repo as it
> actually is; it never edits the plan. Findings only — zero is a result.

**Hunted**: 2026-08-20, against commit `8f18abb` (HEAD — `git diff --stat
8f18abb..HEAD` empty, zero drift from the plan's written-against commit).

**Verdict: 0 findings.** The plan is clean and ready for `run-plan`.

## What was checked

Every step's cited path and symbol was opened live and matched against its
excerpt. No `git ls-files` miss, no invented API, no convention violation, no
ungated step, no assumed dependency.

| Step | File(s) cited                                                                       | Checks run                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | [`edit.ts`](../../../src/tools/edit.ts)                                             | `MAX_MULTI_FILES:53`, both `edits` arrays (`:58`, `:72` — no `.max()`), `.diff` describe (`:108`), `buildDiff` dryRun-only (`:437-452`), real-write branch (`:454-486` never sets `.diff`), RE2 heap comment ([`search.ts:40-45`](../../../src/core/search.ts#L40-L45)), `regexCache` finally (`:411-416`), exemplar [`schema.ts:364`](../../../src/core/schema.ts#L364) `.max(maxBatch)`                                                                   |
| 2    | [`transport.ts`](../../../src/transport.ts)                                         | `MAX_EVENTS_PER_STREAM:57`, `storeEvent` (`:81-100`), per-event eviction (`:92-96`), Map insertion-order evict shape confirmed                                                                                                                                                                                                                                                                                                                              |
| 3    | [`resources.ts`](../../../src/resources.ts)                                         | `createWatcherRegistry` (`:214-264`), `subscribe` (`:353-397`) — `addCallback:356`, `hasWatcher:358`, `isAtCap:361/390`, `extractPath:366`, validate-catch `:372-385`, `isStale:388`, `attach:395`; fix insertion points map onto live exits                                                                                                                                                                                                                |
| 4    | [`registrar.ts`](../../../src/core/registrar.ts)                                    | `finally` (`:237-253`), `destroy()` (`:262-266`); **gate confirmed** — [`eslint.config.mjs:45`](../../../eslint.config.mjs#L45) `eslint.configs.recommended` enables `no-unsafe-finally`                                                                                                                                                                                                                                                                    |
| 5    | [`errors.ts`](../../../src/core/errors.ts) + [`path.ts`](../../../src/core/path.ts) | `ERRNO_MAP:118` (module-local, EACCES/EPERM→PERMISSION_DENIED), `SKIPPABLE_FS_CODES:140-144` (PERMISSION_DENIED absent), `PERMISSION_DENIED` exists, `handleRealpathError:851-897` (non-ENOENT throw → `UNKNOWN` at `:888-896`), consumer [`glob.ts:56-58`](../../../src/core/glob.ts#L56-L58)                                                                                                                                                              |
| 6    | [`replace-in-files.ts`](../../../src/tools/replace-in-files.ts)                     | `globEntries:592-601` (no `respectGitignore`, `baseNameMatch:true`), `resolveSearchRoot:543-559`; exemplars [`search-content.ts:255`](../../../src/tools/search-content.ts#L255) + [`search-files.ts:143`](../../../src/tools/search-files.ts#L143); [`normalizePattern`](../../../src/core/glob.ts#L271-L277) rewrites to `**/${basename}`; **drop-in confirmed** — `processEntriesConcurrently(entries: AsyncIterable<{path:string}>)` at `:441`          |
| 7    | [`glob.ts`](../../../src/core/glob.ts) + [`list.ts`](../../../src/tools/list.ts)    | `getRelativeDepth:367-378` (`return count + 1`), single call site `:397`; `list.ts` `collect` glob call `:95-103` (`maxDepth: options.maxDepth` at `:101`), `ListInputSchema.maxDepth:208-212` (`PositiveInt.max(MAX_TREE_DEPTH).default(...)`); [`MAX_TREE_DEPTH`](../../../src/core/util.ts#L115) `= 50`                                                                                                                                                  |
| 8    | [`search.ts`](../../../src/core/search.ts)                                          | `scanContent:177-184`, `searchFiles:294-301` — neither sets `suppressErrors`; default false at [`glob.ts:356`](../../../src/core/glob.ts#L356); rethrow at [`glob.ts:467-468`](../../../src/core/glob.ts#L467-L468); exemplars `replace-in-files.ts:599` + `calculate-hash.ts:156`                                                                                                                                                                          |
| 9    | [`delete-file.ts`](../../../src/tools/delete-file.ts)                               | pre-elicitation `lstat:183` → `itemStats`, post-elicitation `lstat:214` → `currentStats`; **accessor confirmed** — `resolveItemType` (`:102-109`) uses `itemStats.stats.isDirectory()`, so `.stats.dev/.ino/.birthtimeMs` is real, not invented; `birthtimeMs` used at `stat.ts:78`, `create.ts:138`                                                                                                                                                        |
| 10   | [`path-completer.ts`](../../../src/core/path-completer.ts)                          | `MAX_COMPLETION_ITEMS:9`, `findMatchesInDirectory:270-290` (eager `readdir:273`), `findMatchingRoots:233-241` (raw `!==:238`); fix target [`isSamePath`](../../../src/core/path.ts#L198) (exported), `normalizeCaseForComparison` module-private (`:194`); import at `:7` (no `readdir` elsewhere — grep-confirmed single use)                                                                                                                              |
| 11   | [`path.ts`](../../../src/core/path.ts)                                              | doc comment `:499-506` (`assertSafeGlob` — grep 1 hit, this comment only), `normalizeCaseForComparison:194-196` (`IS_WINDOWS ?`), `IS_WINDOWS:124`; `move.ts:252-268` win32/darwin branch above `isCaseOnlyRename:268`; [`ci.yml:29`](../../../.github/workflows/ci.yml#L29) `os: [ubuntu-latest, windows-latest]` — no macOS runner                                                                                                                        |
| 12   | [`cursor.ts`](../../../src/core/cursor.ts) + [`util.ts`](../../../src/core/util.ts) | `OffsetCursorSchema:5-7` (no upper bound), `encode/decodeOffsetCursor` exported; `MAX_SEARCH_RESULTS=10000` at [`util.ts:120`](../../../src/core/util.ts#L120); imports at `search-content.ts:33`, `search-files.ts:24`; both `fetchMax = cursorOffset + pageSize` (`:359`, `:138`)                                                                                                                                                                         |
| 13   | [`prompts.ts`](../../../src/prompts.ts)                                             | `linkToPath:111-119` (`pathToFileURL:114`), callers `:239` + `:370`; `pathToFileURL` import `:16` used only at `:114` (unused post-fix); [`buildFileResourceUri`](../../../src/core/file-uri.ts#L6-L13) exported; resource contracts [`resources.ts:464-470`](../../../src/resources.ts#L464-L470) — `file:` matches none; `buildFileResourceLink` ([`_helpers.ts:54-62`](../../../src/tools/_helpers.ts#L54-L62)) requires `mimeType/size` (not a drop-in) |

## Test anchors verified

Every test file named in Steps 1-13 exists; the specific blocks the plan says
"extend" were located at their cited lines:

- [`event-store.test.ts`](../../../__tests__/unit/event-store.test.ts) — "evicts the oldest event once a stream exceeds the cap" (`:46-57`)
- [`search-abort.test.ts`](../../../__tests__/unit/search-abort.test.ts) — "searchContent — skipped files are counted" (`:54`), "searchFiles — abort marks the scan truncated" (`:195`)
- `single-or-batch-input.test.ts:54`, `directory.test.ts` (`list` maxDepth cases), `elicitation.test.ts:83-109`, `prompts-stdio.test.ts:58-87`, `path-guard.test.ts:58/64`, `move.test.ts:22-52`, `path-completer.test.ts`, `hunt-regressions.test.ts:271-296`, `replace-text.test.ts`, `search-text-pagination.test.ts`, `find-files-pagination.test.ts`, `resource-subscribe-paths.test.ts`, `roots-failure-recovery.test.ts` — all present.

## Notes

- The per-step `node --test --import tsx "<file>"` Verify commands and the full
  `node scripts/tasks.mjs` gate were confirmed runnable on this commit (the
  plan's own recon notes the `--quick` gate passing in 12.5s).
- Step 3's fix inserts `addCallback` before three `return`/`attach` points
  (`:358`, `:389`, `:395`). The `:358` guard is a one-line
  `if (registry.hasWatcher(uri)) return;` — the executor reads "inside the
  block" as "before that return", which is unambiguous given the prose names
  each site. Not a gate defect.
- One citation is off by one line and immaterial:
  [`glob.ts:356`](../../../src/core/glob.ts#L356) is the `suppressErrors`
  default, `:357` is `respectGitignore`'s — both default `false`, so the Step 8
  claim holds regardless. No fix needed.

No defects to hand to `write-plan`. Forward to `run-plan`.
