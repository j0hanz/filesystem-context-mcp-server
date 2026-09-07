# Run: cut the 16 verified over-engineering residues left by the 2026-09-07 audit

Executing [`overeng-residue.plan.md`](overeng-residue.plan.md), started
2026-09-07 at `6cedcca9`, on branch `refactor/overeng-residue`.

Drift check `git diff --stat 6cedcca9..HEAD -- src/ __tests__/` → empty, no
files flagged. Baseline `node scripts/tasks.mjs test` → `pass 276 fail 0`.

- **1** 2026-09-07 — done. Deleted `ToolCtx.sessionId` + `ToolCtx.server` and their three assignments in `define.ts`; `ToolDeps.server` and the `Pick` entry kept. `node scripts/tasks.mjs --quick` → exit 0.
- **2** 2026-09-07 — done. Deleted `singleOrBatchPathsInput`'s `maxBatch` option and the `?? DEFAULT_MAX_BATCH` fallback; constant used directly. `node scripts/tasks.mjs --quick` → exit 0.
- **3** 2026-09-07 — done. Deleted the never-passed `annotations` param from both link builders; `{ audience: ['user', 'assistant'] }` inlined. `node scripts/tasks.mjs --quick` → exit 0.
- **4** 2026-09-07 — done. Inlined `createReadRangeFields` into `read.ts` as a local `rangeField` helper; factory + `ReadRangeDescriptions` + its TODO deleted from `schema.ts`. `node scripts/tasks.mjs test` → `pass 276 fail 0`; `--quick` → exit 0.
- **5** 2026-09-07 — done. Deleted `ALL_REGISTERED_TOOL_NAMES` from `src/tools/index.ts`; six test files now compute it from `ALL_TOOLS` locally. Prettier flagged `tools.test.ts`, fixed by `node scripts/tasks.mjs fix`. `test` → `pass 276 fail 0`; `--quick` → exit 0.
- **6** 2026-09-07 — done. Deleted the zero-caller `Problem.ioError`; `ErrorCode.IO_ERROR` kept. `node scripts/tasks.mjs --quick` → exit 0.
- **7** 2026-09-07 — done. Collapsed all four declarations of `{code, message, path?, suggestion?}` onto `Problem`: deleted `PerFileError` and `toPerFileError`'s rebuild, `batch.ts`'s `PerPathError`, and `delete-file.ts`'s inline `DeleteFailure.error`. `test` → `pass 276 fail 0`; `--quick` → exit 0.
- **8** 2026-09-07 — done. Extracted `computeDiffStats` + `unifiedPatch` into `src/core/fmt.ts`; repointed `edit.ts` (both sites), `diff.ts` (stats loop), `replace-in-files.ts` (patch call). `diff.ts` keeps its own `createTwoFilesPatch` call. `test` → `pass 276 fail 0`; `--quick` → exit 0.
- **9** 2026-09-07 — done, with one deviation. Extracted `buildWrittenFileMeta` into `src/core/file-uri.ts`; repointed `patch.ts`, `edit.ts`, `create.ts`. **Deviation**: the plan put the `appliedEdits > 0` gate inside the helper as a `written` option; the helper instead has no mode flag and `edit.ts`'s `buildEditFileMetadata` applies the gate at its own site (`written ? meta.resourceUri : undefined`, same for the link). The gate is preserved exactly and only edit.ts has one — no caller-visible difference, one fewer parameter. No import cycle: `mime.ts`/`read.ts`/`schema.ts`/`store.ts` do not import `file-uri.ts`. `test` → `pass 276 fail 0`; `--quick` → exit 0.
- **10** 2026-09-07 — done. Deleted `getFileType` from `fs.ts`; `stat.ts` and both `delete-file.ts` sites now call `resolveEntryType` from `core/glob.js`. `test` → `pass 276 fail 0`; `--quick` → exit 0.
- **11** 2026-09-07 — done. `GuardedFileSystem.open` reduced to `open(filePath)` with a fixed `'r'`; the write-guard branch, the flags/mode params, and the now-dead `constants as fsConstants` import removed; `replace-in-files.ts:375` updated. `test` → `pass 276 fail 0`; `--quick` → exit 0.
- **12** 2026-09-07 — done. `searchFiles` sortBy 'name' now uses `basename()` from `node:path`; added TC-FUNC-039b to `core-fs.test.ts`. `test` → `pass 277 fail 0`; `--quick` → exit 0. **Note**: the new test pins the branch's behavior (basename order vs path order), which was previously uncovered. It does not distinguish the old comparator from the new one — the two differ only for a literal `\` inside a filename, which is not representable on this Windows host.
- **13** 2026-09-07 — done. Folded the pair driver into `move.ts` as non-generic `runTransfers` over `TransferPlan`/`MoveItemResult`; `pairFailure` moved with it and now returns `MoveFailureItem`. Deleted from `batch.ts`: `PairFailureItem`, `PairPlan`, `PairPlanResult`, `PairExecResult`, `PairBatchOutcome`, `RunOverPairsOptions`, `pairFailure`, `runOverPairs`, and the imports only they used (`InputRequiredResult`, `choiceInput`, `pendingRoundTrip`, `IS_CASE_INSENSITIVE_FS`, `rethrowIfAborted`); `isTotalFailure`'s doc comment reworded. Body moved verbatim — same fail-closed plan-error rethrow, duplicate-destination guard and message, `confirm_${i}` indexing over the sorted pending list, progress tick, and abort rethrow. `node scripts/tasks.mjs` → exit 0, `pass 277 fail 0`.

## Done

- [x] `node scripts/tasks.mjs --quick` → exit 0 (build, both type-checks, eslint, prettier, knip clean).
- [x] `node scripts/tasks.mjs test` → `tests 277 · suites 61 · pass 277 · fail 0`.
- [x] `git status` → 25 modified files, all in the plan's in-scope list; the only untracked path is this effort's own `docs/plan/2026-09-07-overeng-residue/`.
- [x] `git grep -n "PerFileError" src/` → remaining hits are `PerFileErrorSchema` (the wire schema, a different identifier) and `Problem.toPerFileError` (kept). No `PerFileError` interface.
- [x] `git grep -n "runOverPairs\|PairBatchOutcome\|PairPlanResult\|PairExecResult\|PairFailureItem\|getFileType\|createReadRangeFields\|ALL_REGISTERED_TOOL_NAMES\|ioError" src/` → empty, after fixing one out-of-plan hit (below).
- [x] `git grep -c "createTwoFilesPatch" src/` → `src/core/fmt.ts:3`, `src/tools/diff.ts:3`. Nothing else.

## Deviations

1. **Step 9** — the `appliedEdits > 0` gate stayed at `edit.ts`'s call site instead of becoming a `written` option on the shared helper. The helper has no mode flag; `buildEditFileMetadata` blanks `resourceUri`/`resourceLink` itself. Gate preserved exactly, one fewer parameter, no caller-visible difference.
2. **Done checklist, hit outside the plan** — `src/core/primitives.ts:8` carried a doc comment naming `getFileType`. Step 10 deleted the function but the plan never listed this file. Fixed as a one-word comment edit (the sentence now names only `resolveEntryType`); no code touched. Reported rather than silently widened.
3. **Step 12 test scope** — TC-FUNC-039b pins the `sortBy: 'name'` branch's behavior (previously zero coverage) but cannot distinguish the old comparator from the new one: they differ only for a literal `\` inside a filename, which Windows cannot create.

## Post-review pass — 2026-09-07

`bug-hunt` returned zero findings (see [`overeng-residue.hunt.md`](overeng-residue.hunt.md)).
`qc` returned REQUEST_CHANGES with four shape regressions and six missed
code-judo moves — no behavior objection. All ten applied on the same branch.

- **R1** `src/core/file-uri.ts:9-11` — module header restated; it claimed to own only the URI scheme while the file had grown the post-write metadata block.
- **R2** `computeDiffStats` + `unifiedPatch` moved out of `fmt.ts` into a new `src/core/diff.ts`; `fmt.ts` formats terminal output and no longer drags the `diff` package into `cli.ts`'s import chain. Repointed `edit.ts`, `diff.ts`, `replace-in-files.ts`.
- **R3** `resolveEntryType` + `DirentLike` moved from `core/glob.ts` to `core/primitives.ts`, which already owns `ENTRY_TYPES`/`EntryType`. `stat.ts`, `delete-file.ts` and `list.ts` now import the concept from its owner instead of routing through the glob module; no re-export left behind.
- **R4** `ALL_REGISTERED_TOOL_NAMES` moved to `__tests__/helpers.ts` as one export. Step 5 had traded a single production export for six verbatim copies; `src/tools/index.ts` still stops exporting for tests, which was the point.
- **J5** `runTransfers` dropped its `plan`/`execute` callback parameters — one call site, both wrappers closing over only `op`/`ctx`/`overwrite`. Now `runTransfers(items, ctx, op, overwrite)` calling `planTransfer`/`executeTransfer` directly.
- **J6** `Problem.toPerFileError` deleted — step 7 had collapsed it to a pass-through over `fromUnknown`. Five call sites (`batch.ts`, `delete-file.ts` ×3, `move.ts`) repointed; all already passed an explicit `defaultCode`, and `replace-in-files.ts` already called `fromUnknown` directly.
- **J7** `singleOrBatchPathsInput` takes `extra` directly instead of a one-field options bag (`{ extra: {} }` had outlived `maxBatch`).
- **J8** dead `signal` parameter dropped from `maybeAppendPatchDiff` and its call site.
- **J9** `WrittenFileMeta.bytesWritten` renamed to `size` — all four consumers renamed it at the use site. `EditFileMetadata` collapsed to `Omit<WrittenFileMeta, 'resourceUri'> & { resourceUri: string | undefined }`, removing the fifth hand-declaration of the shape.
- **J10** `isTotalFailure` narrowed to `{ total, failed }`; the pair-shape branch and its `'total' in shape` discriminant are gone, inlined at `move.ts`'s one call site. That was the last piece of the pair driver still living in `batch.ts`.

`node scripts/tasks.mjs` → exit 0, `tests 277 · suites 61 · pass 277 · fail 0`.
Net across the branch: 28 files, 337 insertions, 502 deletions (-165 lines).
