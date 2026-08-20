# Bug Hunt — bug-hunt-fixes (dev vs main, 2026-08-20)

Scope: the landed 15-file diff (Steps 1-13) on `dev` vs `main` —
[`bug-hunt-fixes.run.md`](bug-hunt-fixes.run.md). Correctness and security only;
structure is out of scope (qc owns it).

## Confirmed

### Completion cap applied before the alphabetical sort — Minor

finding [`path-completer.ts:286`](../../../src/core/path-completer.ts#L286)
in symbol `PathCompleter.findMatchesInDirectory`

`findMatchesInDirectory` now streams via `opendir` and breaks at
`MAX_COMPLETION_ITEMS` (100) as the **first** statement inside the
`for await (const entry of dir)` loop:

```ts
if (matches.length >= MAX_COMPLETION_ITEMS) break;
```

`opendir` yields entries in filesystem/inode order, not alphabetical. The
alphabetical sort runs only later, in `mergeCompletionMatches` →
`sortCompletionMatches` (line 266 → 249-258), and the final
`.slice(0, MAX_COMPLETION_ITEMS)` is at the call site (lines 365-367). Both
operate on the already-capped ≤100 subset, so an alphabetically-earlier entry
sitting at opendir position >100 is dropped before the sort ever sees it — the
sort the code otherwise applies is defeated.

**Trigger.** A path-completion request where the directory being completed
holds more than 100 entries matching the typed prefix. With `prefix === ''`
the prefix filter (line 287) is skipped, so every entry counts toward the 100.

**Impact.** Returned completions are the opendir-first-100 (then sorted), not
the alphabetically-first 100; users get a non-deterministic, less useful
suggestion set and may not see the entries they'd expect. Regression from the
prior `readdir`-then-cap behavior, which returned all matches, sorted, then
sliced to the alphabetical-first 100. No data loss, no security impact —
suggestions only.

**Ruled out.** No post-collection re-fetch or alphabetical re-scan exists
between the break and the merge; `sortCompletionMatches` reorders only what
`findMatchesInDirectory` returned, and `.slice` only truncates. Verbatim, from
the merge path: `PathCompleter.sortCompletionMatches(merged);` (line 266) —
`merged` is exactly the capped set. The Step 10 test asserts only
`results.length === 100`, never the specific entries, so it does not catch
which 100.

**Fix (suggested, not applied).** Either drop the in-loop `break` and rely on
the post-sort `.slice` cap (reverts the streaming optimization but restores
correctness), or keep streaming but collect without the count cap and let the
merge `.slice` select the alphabetical-first 100. A bounded-buffer variant that
preserves ordering would need a partial-sort/heap over the stream — only worth
it if the unbounded-collect cost is real (profile a >10k-entry dir first).

Refuted blind by one general-purpose subagent — verdict **confirmed**.

## Suspected

None.

## Coverage

Read end to end (changed + contract): `src/resources.ts`, `src/transport.ts`,
`src/tools/replace-in-files.ts`, `src/tools/delete-file.ts`, `src/tools/edit.ts`,
`src/tools/list.ts`, `src/prompts.ts`, `src/tools/search-files.ts`, and the named
test files `__tests__/prompts-stdio.test.ts`, `__tests__/tools/find-files-pagination.test.ts`.

Read at the changed regions plus surrounding contract context (not end to end):
`src/core/path-completer.ts` (full audit of the streaming cap + `findMatchingRoots`
case-fold), `src/core/glob.ts` (`getRelativeDepth` + caller depth semantics),
`src/core/path.ts` (`normalizeCaseForComparison`/`isSamePath` +
`handleRealpathError` errno mapping + skippable set), `src/core/errors.ts`
(`ERRNO_MAP` export + `SKIPPABLE_FS_CODES`), `src/core/registrar.ts`
(`McpRootsSynchronizer` shutdown re-check), `src/core/search.ts` (the two
`suppressErrors` `globEntries` calls), `src/tools/search-content.ts` (the
`Math.min` cursor clamp).

Blast-radius callers checked by grep, not re-read in full: every `globEntries`
`maxDepth` caller (`list.ts`, `search-files.ts`, `replace-in-files.ts`,
`search.ts`) to confirm the `getRelativeDepth` off-by-one fix is compensated
consistently — `list` is 1-based (subtracts 1); `find_files`/`replace_text`
use the 0-based `maxDepthField` ("0 = base directory only") and pass it direct;
`search.ts` defaults `maxDepth ?? 100`. Coherent.

Third-party behavior taken on trust: the SDK `StreamableHTTPServerTransport`
stream lifecycle in `@modelcontextprotocol/server/dist/index.mjs` — read far
enough to confirm per-request streams get fresh UUIDs (`crypto.randomUUID()`,
line 684) and that the `EventStore` interface exposes no stream-removal method
(so per-request streams accumulate until session `clear()`). Consequence
checked: the new `MAX_EVENT_STREAMS` FIFO eviction can eventually evict the
long-lived `_GET_stream`, but the store's own doc comment
(`transport.ts:65-77`) makes event loss best-effort ("lost across process
restarts and once evicted") and the live GET stream keeps delivering — eviction
only breaks replay-after-reconnect, the permitted best-effort failure. Not a
defect; not reported.

Not audited (out of scope): structure/style (qc); behavior against requirement
IDs (none cited by the plan's Goal, so verify-specs is not invoked).
