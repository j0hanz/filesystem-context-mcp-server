# Hunt: core-qc-fixes

Bug-hunt over the landed 16-step refactor of `src/core/` (plan
`core-qc-fixes.plan.md`, run `core-qc-fixes.run.md`), uncommitted working
tree on `dev`, base `5d882ed`. Read-only audit; no code was edited or
executed.

## Confirmed

### 1. `skippedInaccessible` inflated past the result cap in `searchFiles` / `searchContent` — Minor

**What's wrong.** Step 15 unified the two scan loops behind
`guardedEntries(entries, pathGuard, signal, counters)`. The generator
runs `pathGuard.validateExistingPath(entry.path)` on every glob entry and
only `yield`s the ones that pass; inaccessible entries increment
`counters.skippedInaccessible` and are skipped via `continue`. The
result-cap check (`if (matches.length >= maxResults) break;` /
`if (results.length >= maxResults) break;`) lives in the *caller's* loop
body — so it runs one `it.next()` too late: by the time the caller sees an
entry and can break, `guardedEntries` has already pulled and validated at
least that entry, and, because of the `continue` on validation failure,
every inaccessible entry between the last yielded result and the next
validated-and-yielded entry (or the end of the glob).

The old code ordered the checks the other way: abort check, then the cap
break, then `validateExistingPath`. It broke at the cap *before*
validating the next entry, so entries past the cap were never validated
and never counted.

**Trigger.** A `searchFiles` or `searchContent` call reaches its
`maxResults` cap AND at least one glob entry after the cap's last yielded
result fails `validateExistingPath` before the next accessible entry (or
end of the glob). The real-world trigger is a search that truncates over a
directory containing permission-denied / dangling-symlink entries after
the result cap is reached.

**Impact.** The `skippedInaccessible` summary field reported to the MCP
client is inflated — it counts inaccessible files the caller never asked
about (potentially many, not just one: the `continue` walks the whole
run of inaccessible entries between the cap and the next yield). Minor
wasted I/O (a `realpath` per skipped entry) runs after the cap is already
effectively reached. No impact on the matches themselves, the
`truncated` flag, `stoppedReason`, `filesScanned`, or `filesMatched`; no
security or access-control impact (results and the cap are correct).

**Ruled-out line.** No guard stops the post-cap validation:
`guardedEntries`'s signature takes no `maxResults`
(`src/core/search.ts:143-148`: `async function* guardedEntries(entries,
pathGuard, signal, counters)`) and its only early-exit is the abort check
(`src/core/search.ts:153-156`: `if (signal?.aborted) {
counters.stoppedByAbort = true; return; }`). The caller's cap check is in
the loop body, one `.next()` too late — verbatim
`src/core/search.ts:192-193`:
```
for await (const entry of guardedEntries(entries, pathGuard, options.signal, counters)) {
    if (matches.length >= maxResults) break;
```
and the generator body that validates-and-counts before yielding —
verbatim `src/core/search.ts:157-164`:
```
      try {
        await pathGuard.validateExistingPath(entry.path);
      } catch {
        counters.skippedInaccessible++;
        continue;
      }
      yield entry;
```
The prior contract is visible at the base commit —
`git show 5d882ed:src/core/search/engine.ts` (old `searchFiles`) ordered
`if (results.length >= maxResults) break;` *before* the
`try { await pathGuard.validateExistingPath(...) }` block, so the cap
broke before any post-cap entry was validated/counted. The old
`scanContent` had the same order. The unification flipped them.
Independent refuter graded the current code `confirmed`.

**Fix (not applied).** Move the cap check into the generator: pass
`maxResults` and a live count (or the result accumulator) into
`guardedEntries` and have it check the cap *before* validating each entry,
returning early once the cap is reached. That restores the old
"cap-before-validate" order at both call sites without re-duplicating the
abort/validate/skip skeleton. Alternatively, keep the skeleton and
accept the new count as intentional, but then the plan's "preserve prior
behavior" criterion for step 15 is not met and the behavior change should
be called out in the commit.

## Suspected

None.

## Coverage

**Read in full:** `src/core/path.ts`, `src/core/registrar.ts`,
`src/core/concurrency.ts`, `src/core/mime.ts`, `src/core/glob.ts`,
`src/core/search.ts`, `src/core/errors.ts`, `src/core/store.ts`,
`src/core/path-completer.ts`, `src/core/read.ts`, `src/core/fs.ts`,
`src/core/util.ts`, `src/tools/search-content.ts`,
`src/tools/search-files.ts`, `src/tools/replace-in-files.ts` (scan-root
+ glob call site region), `src/tools/list.ts`, `src/tools/move.ts`,
`src/tools/delete-file.ts` (changed call-site regions).

**Tests read in full:** `__tests__/unit/abort.test.ts`,
`__tests__/unit/path-guard-atomic.test.ts`,
`__tests__/unit/roots-failure-recovery.test.ts`,
`__tests__/unit/search-abort.test.ts`, `__tests__/unit/mime.test.ts`,
`__tests__/unit/errors.test.ts`, `__tests__/unit/util.test.ts`;
import lines of `__tests__/unit/replace-dollar-expansion.test.ts` and
`__tests__/unit/read-line-bounds.test.ts`.

**Blast radius pulled in:** call-site updates for the six deleted
`GuardedFileSystem` pass-throughs (grepped — all 13 call sites now use
`fs.pathGuard.x(...)` / `ctx.fs.pathGuard.x(...)`); importer redirects for
the `read.ts` split and the `search/engine.ts` → `search.ts` move
(grepped — no stale `core/search/engine` imports remain); the
`buildGlobOptions` / `ProcessContext` removal in `glob.ts` (engine.ts
call sites now pass literals to `globEntries`).

**Compared against base `5d882ed` via git:** old
`src/core/search/engine.ts` (both scan loops), old
`src/core/concurrency.ts`, old `src/core/path.ts` (recomputeAllowedDirectories
+ the two env-dir loops), old `src/core/glob.ts` (dispatch + ProcessContext
+ buildGlobOptions) — to verify the step-8 dispatch, step-10 message
preservation, step-12 error-code change, and step-13 defaulting parity.

**Highest-risk areas scrutinized (per the plan's own STOP/Notes) and
cleared:**

- **Step 1 `setRoots` rollback / atomic recompute** — correct.
  `recomputeAllowedDirectories` commits `rootBoundaries` + `initialize`
  together at `path.ts:1182-1183` after every await; `setRoots` rolls
  `rootDirectories` back to `previous` on rejection (`path.ts:658-669`).
  During the in-flight recompute, access-control reads go through
  `allowedDirectoriesState` (not the transient `rootDirectories`), so no
  window exposes a partially-applied allowed-dir set. Security posture
  holds.
- **Step 2 registrar finally / clear-on-failure** — correct. The finally
  try/catches `setRoots` so `state = 'idle'` survives rejection
  (`registrar.ts:238-251`); the `listRoots` catch clears
  `this.rootDirectories = []` (`registrar.ts:236`) so stale client roots
  are not re-granted; `pendingRootsUpdate` is still drained. The `state`
  widening to `string` (with the explanatory comment, `registrar.ts:127-132`)
  is the plan's documented fallback and is sound.
- **Step 12 deadline → TIMEOUT** — correct. `processInParallel`'s final
  `signal?.throwIfAborted()` (`concurrency.ts:56`) surfaces
  `signal.reason` (a `TimeoutError` for `timedSignal`) instead of the old
  fresh `AbortError`; `withAbort` rejects with `signal.reason` when it is
  an `Error` and wraps non-`Error` reasons (`concurrency.ts:75-76`). The
  new `abort.test.ts` case (lines 45-65) asserts the rejection's `name ===
  'TimeoutError'` and is real.
- **Step 9 `KNOWN_BINARY_EXTENSIONS` derivation** — correct. Derived from
  `EXT_MAP` non-`text` kinds + `EXTRA_BINARY_EXTENSIONS`, with `svg`
  filtered out (`mime.ts:229-238`); no `text`-kind extension leaks into the
  binary set (the filter is `v.kind !== 'text'`). `isKnownBinaryExtension('a.svg') === false`
  and `isKnownBinaryExtension('a.xz') === true`, matching the new tests.
- **Step 8 glob skippable dispatch** — correct.
  `isEntryAccessibleByType` dispatches `isFsError` → `SKIPPABLE_FS_CODES`
  else rethrow, then `isNodeError && error.code !== undefined` →
  `SKIPPABLE_ERRNOS` else rethrow (`glob.ts:55-63`). The
  `error.code !== undefined` guard is present before `SKIPPABLE_ERRNOS.has`.
  Dangling-symlink-in-allowed-root surfaces as `FsError(NOT_FOUND)` →
  skipped, not rethrown (NOT_FOUND is in `SKIPPABLE_FS_CODES`).
- **Step 13 glob inlining / dead-arg fix** — correct. `processGlobPattern`
  reads `cwd`/`maxDepth`/`suppressErrors` from `plan` (`glob.ts:450`);
  `seen`/`onlyFiles` are params; `globEntries` defaults `onlyFiles ?? true`
  (`glob.ts:483`), matching the old `buildGlobOptions`. The dead `''`
  argument is gone — `createExcludeFilter` calls
  `gitignoreMatcher.isIgnored(posixRel, isDir)` directly (`glob.ts:428`);
  `isIgnoredByGitignore` is retained for `calculate-hash.ts`.
- **Step 14 store hash-once / overloads** — correct. `putText`/`putBlob`
  compute `computeSha256` + `estimateBytes` once and pass them down
  (`store.ts:273-281`, `:301-309`); `rawPut`, `checkBeforePut`, and
  `tryReturnHashHit` take the precomputed values and do not re-derive.
  `getExisting` / `tryReturnHashHit` overloads return narrowed kinds with
  no `as` casts. The `tryReturnHashHit` refresh path (TTL refresh via
  `bumpLru`, kind-mismatch removal) is unchanged.
- **Step 16 path-completer options bag** — correct. `completePath(value,
  argumentName, contextArguments?)` reads `this.pathGuard` directly
  (`path-completer.ts:328-333`, `:356`); `argumentName` defaults to `''`
  in `suggest` (`:28`), so the dropped `?? ''` fallback is safe.

**Not audited and why:** `src/tools/edit.ts`, `src/tools/create.ts`,
`src/tools/read.ts` — only step-4 import-line changes (verified via grep
to point at `../core/read.js`); no logic touched. `src/tools/define.ts`,
`src/tools/batch.ts`, `src/tools/calculate-hash.ts`, `src/tools/stat.ts`
— blast-radius callers of `processInParallel`/`MAX_TEXT_FILE_SIZE` read
only far enough to confirm the contract (the deadline-code change is
covered by `abort.test.ts`); not re-read in full. `src/server.ts`,
`src/transport.ts`, `src/resources.ts`, `src/prompts.ts` — out of scope by
the plan and unmodified (confirmed by the run log's `git status` note).
Snapshot file `__tests__/schemas/__snapshots__/tool-schemas.json` —
generated; the run log describes the deliberate 5-line `stoppedReason`
insertion. The full `replace-in-files.ts` (790 lines) was read only in the
scan-root/glob region (lines 535-604) and its call-site updates; the
replacement-matcher logic was not re-audited (unchanged by this plan).

**Third-party behavior taken on trust:** `AbortSignal.timeout` aborts
with a `DOMException` whose `name` is `'TimeoutError'` (relied on by step
12 and its test); `node:fs/promises` `glob` with `withFileTypes: true`
reportsDirent entries whose `isFile()` is false for directories and
symlinks (relied on by the step-15 dropped-directory-check safety
argument); `re2-wasm`'s fixed 16 MB heap and no self-free (unchanged,
covered by `search-abort.test.ts`).

**Refuter note:** one candidate finding was sent to a blind general-purpose
refuter (subagent). It returned `{"verdict":"confirmed", ...}`,
independently ruling out any guard in the current code. The old-code
comparison was performed in-thread via `git show 5d882ed:...` because the
refuter has no git access.