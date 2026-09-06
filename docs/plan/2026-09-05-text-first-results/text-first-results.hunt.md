# Code hunt: search-tool page trailers

Hunted 2026-09-06 against the uncommitted working tree on `main` (baseline
`d9f7a4a8`). Scope: the four changed files plus blast radius.

> **Resolved 2026-09-06.** All four confirmed findings were fixed in the same
> working tree. `core/cursor.ts` now returns the page `offset`, so both search
> trailers report `showing N-M of T` and advance across pages; each tool emits a
> second line keyed on `stoppedReason`, independent of `nextCursor`, so an
> engine-cut scan says so even when the partial set fits one page; the
> `find_files` assertion writes two files into its own subdirectory. Three tests
> added — page advance, engine cut (10 001-line fixture), and the isolation fix.
> `node scripts/tasks.mjs` → 278 pass, 0 fail; the trailer tests also pass under
> `--test-name-pattern 'page trailer'` alone. Not re-hunted.

Filed here rather than under `2026-09-05-audit-seams/` because the change under
audit continues [`text-first-results.plan.md`](text-first-results.plan.md): that
plan gave `read` and `list` text trailers and deliberately left `find_files` and
`search_text` carrying their metadata in `_meta` alone (plan
[step 5](text-first-results.plan.md), inventory rows for both tools). The diff
extends the same fix to those two tools. `M-01` in `audit-seams` is closed and
covers different seams.

**Verdict**: a `search_text` that hits its own 5-second timeout still returns a
partial result whose text is byte-identical to a complete one — the silent
truncation this diff set out to close, left open for the engine's own stop.

## Confirmed

### 1. Major — truncated scan renders a partial count as the total

[`search-content.ts:435`](../../../src/tools/search-content.ts#L435)

**What**: the trailer prints `${totalMatches}` as the denominator, but
`totalMatches` is `result.summary.matchingLines`
([`search-content.ts:353`](../../../src/tools/search-content.ts#L353)), which is
incremented only alongside `matches.push` inside a loop bounded by
`if (matches.length >= maxResults) break;`
([`search.ts:196`](../../../src/core/search.ts#L196),
[`:232`](../../../src/core/search.ts#L232)) and by
`counters.stoppedByAbort = true` on the composed timeout signal
([`search.ts:156`](../../../src/core/search.ts#L156)). It is the size of what
was kept, never a scan-wide tally.

**Trigger**: two shapes.

- Cap hit: >10 000 matching lines (`MAX_SEARCH_RESULTS`,
  [`util.ts:104`](../../../src/core/util.ts#L104)) with the default page size of
  500 ([`util.ts:108`](../../../src/core/util.ts#L108)) prints
  `500 of 10000 matches shown` as though 10 000 were the total.
- Timeout: `FS_SEARCH_TIMEOUT_MS` defaults to 5000 ms
  ([`util.ts:97`](../../../src/core/util.ts#L97)); `composeSignal`
  ([`define.ts:209`](../../../src/tools/define.ts#L209)) folds it into the run
  signal and `guardedEntries` returns partial data rather than throwing
  ([`search.ts:151-158`](../../../src/core/search.ts#L151-L158)). If the partial
  set fits one page there is **no cursor**, so the trailer is skipped entirely
  and a cut scan is indistinguishable from a complete one.

**Impact**: a caller reads a capped or timed-out result as the whole answer and
never learns to narrow the search. This is the failure mode the trailer was
added to prevent, surviving in the one case the trailer does not cover.

**Ruled out**: the only two truncation carriers are written solely into the
structured half —
`...(metadata.truncated ? { truncated: true } : {}),`
([`search-content.ts:168`](../../../src/tools/search-content.ts#L168)) and
`...(metadata.stoppedReason !== undefined ? { stoppedReason: metadata.stoppedReason } : {}),`
([`:169`](../../../src/tools/search-content.ts#L169)) — which `defineTool` ships
as `{ _meta: result.structured as Record<string, unknown> }`
([`define.ts:233`](../../../src/tools/define.ts#L233)) for any tool that authors
text. `stoppedReason` appears in no text-building expression anywhere in `src`.
No test covers an engine-truncated page:
[`tools.test.ts:1451`](../../../__tests__/tools.test.ts#L1451) asserts the
complete case and [`:1416-1420`](../../../__tests__/tools.test.ts#L1416-L1420)
asserts `truncated` is `undefined` for the paging case.

**Fix** (not applied): gate a second trailer line on `structured.truncated`,
independent of `nextCursor`, naming `stoppedReason` and marking the count a
floor — e.g. `// scan stopped early (timeout); count is a floor, narrow the
search`. [`T-06`](../2026-09-05-audit-seams/tickets/T-06-search-text-truncated.md)
already fixed `truncated` to mean exactly the engine's stop state, so the signal
is available and its meaning settled.

### 2. Major — same false total at the `find_files` site

[`search-files.ts:234`](../../../src/tools/search-files.ts#L234)

**What**: `totalMatches` is `result.summary.matched`
([`search-files.ts:171`](../../../src/tools/search-files.ts#L171)), built as
`matched: results.length` ([`search.ts:333`](../../../src/core/search.ts#L333))
— definitionally the collected array's size, bounded by
`if (results.length >= maxResults) break;`
([`search.ts:307`](../../../src/core/search.ts#L307)) and by the same soft abort.

**Trigger**: as above. `find_files` publishes no `truncated` field at all
(recorded independently in
[`T-06`](../2026-09-05-audit-seams/tickets/T-06-search-text-truncated.md)), so
`stoppedReason` is the only carrier — and it rides `_meta`.

**Impact**: `N of <partial> files shown` on a capped or timed-out walk.

**Ruled out**: the resource link cannot substitute — `putJsonResource` names the
block `` `${args.pattern} files` `` with `annotations: { audience: ['user'] }`,
carrying no cut signal and not addressed to the model. `stoppedReason` has zero
matches under `__tests__/`. The tool's own comment concedes the mechanism:
`// See search-content.ts: nextCursor rides `_meta`, which no client renders.`
([`search-files.ts:232`](../../../src/tools/search-files.ts#L232)) — the author
compensated for `nextCursor` alone.

**Fix** (not applied): same shape as finding 1, keyed on `stoppedReason` since
this tool has no `truncated` field.

### 3. Major — order-dependent test assertion

[`tools.test.ts:1467`](../../../__tests__/tools.test.ts#L1467)

**What**: `assert.match(firstTextBlock(files).text ?? '', /Next page: find_files \{"cursor":"/);`
points `find_files` at the shared `tmpDir` with `maxResults: 1` and depends on
files left there by ~60 earlier `it()` blocks.

**Trigger**: running the test alone (`--test-name-pattern 'page trailer'`). The
root holds only the test's own `trailer/hits.txt`. `searchFiles` calls
`globEntries` without `onlyFiles`, which defaults on
([`glob.ts:462`](../../../src/core/glob.ts#L462)) and drops the `trailer`
directory ([`glob.ts:382`](../../../src/core/glob.ts#L382)), so `**/*` yields
exactly 1 item. `createFirstPage` withholds the cursor when
`params.items.length <= params.pageSize`
([`cursor.ts:40`](../../../src/core/cursor.ts#L40)), the trailer is gated on the
cursor alone ([`search-files.ts:233`](../../../src/tools/search-files.ts#L233)),
and the assertion fails.

**Impact**: the assertion proves nothing about the `find_files` trailer when run
alone; it passes on accumulated state from unrelated tests.

**Ruled out**: `tmpDir` is created once in a `before` hook
([`tools.test.ts:46`](../../../__tests__/tools.test.ts#L46)) from `mkdtemp`
([`helpers.ts:28`](../../../__tests__/helpers.ts#L28)); the file has one
`describe` and no `beforeEach`, and `after` is the only cleanup. The resource
store cannot pad the directory — `src/core/store.ts` imports no `node:fs`.
`truncated` cannot supply the cursor either: `paginate` uses it only to attach a
`resource` ([`cursor.ts:114`](../../../src/core/cursor.ts#L114)). The
`search_text` half of the same test is self-contained by contrast — it writes 9
lines precisely so `maxResults: 4` must page
([`tools.test.ts:1444`](../../../__tests__/tools.test.ts#L1444)).

**Fix** (not applied): write a second file into a test-owned subdirectory and
point `find_files` at that subdirectory instead of `tmpDir`.

### 4. Minor — page-N trailer does not advance

[`search-content.ts:435`](../../../src/tools/search-content.ts#L435),
[`search-files.ts:234`](../../../src/tools/search-files.ts#L234)

**What**: the numerator is the current slice's length and the denominator the
whole-set total, so page 2 emits a byte-identical line to page 1.

**Trigger**: 150 matches at `maxResults: 60` prints `// 60 of 150 matches shown.`
on page 1 and the same string on page 2 (page 3 has no cursor, so no trailer).

**Impact**: the figure does not advance, so the text cannot say how far through
the set a reader is. Ranked Minor rather than Major — the cursor is still
correct and paging still terminates; only the progress figure misleads. Torn
between Minor and Major; taking the lower.

**Ruled out**: the offset that would make the count cumulative is consumed
inside `pageResult` and never returned — `PaginatedPage`
([`cursor.ts:69-75`](../../../src/core/cursor.ts#L69-L75)) exposes only `page`,
`metadata`, `nextCursor`, and the replay path returns the snapshot's metadata
verbatim (`metadata: snapshot.metadata`,
[`cursor.ts:24`](../../../src/core/cursor.ts#L24);
[`page-store.ts:91-94`](../../../src/core/page-store.ts#L91-L94) never rewrites
it). Grepping `offset` across `src/tools` finds no consumer. No test exercises a
continuation-page trailer: the multi-page test at
[`tools.test.ts:1400`](../../../__tests__/tools.test.ts#L1400) uses an exact
two-page split whose second page carries no trailer.

**Fix** (not applied): thread the page offset out of `paginate` and print
`shown N-M of T`, or drop the denominator and print only the cursor.

## Suspected

None.

## Dismissed — do not re-raise

- **`instructions.ts:71` still names `_meta` as the cursor's home** — killed. The
  structured half is unchanged, so `_meta` does carry `nextCursor` for both
  tools; the text line is additive. The guidance is incomplete, not wrong.
- **`String(structured.totalMatches)` could render the literal `"undefined"`** —
  assigned unconditionally at
  [`search-content.ts:161`](../../../src/tools/search-content.ts#L161) and
  [`search-files.ts:125`](../../../src/tools/search-files.ts#L125) from a
  required-typed metadata field; optional only in the Zod output schema.
- **`REGEX_METACHARACTERS.test()` statefulness** — the literal carries no `/g`
  flag, so `lastIndex` never advances.
- **`requestedPath` in the read continuation** — `filePath` is the caller's own
  string (`known` is keyed on it,
  [`read.ts:242-245`](../../../src/tools/read.ts#L242-L245)); the resource URI
  still derives from `result.path`, so the case-mismatch guard at
  [`read.ts:519`](../../../src/tools/read.ts#L519) is untouched.
- **Removal of the `totalLines` hint branch in `read`** — only `readFull` sets
  `totalLines` and it sets `hasMoreLines: false`
  ([`core/read.ts:661-676`](../../../src/core/read.ts#L661-L676)), while a
  continuation is built only when `hasMoreLines` is true. The branch was
  unreachable.

## Coverage

**Read in full**: `src/tools/read.ts`, `src/tools/search-content.ts`,
`src/tools/search-files.ts`; the 48 changed lines of `__tests__/tools.test.ts`
plus `TC-FUNC-074` and the four existing search/pagination tests.

**Blast radius**: `src/instructions.ts` (pagination and limits lines),
`src/tools/index.ts` (re-export only), `src/tools/define.ts:205-240`
(`buildSuccessResponse`), `src/core/cursor.ts` (`paginate`, `createFirstPage`,
`pageResult`, `readNextPage`), `src/core/search.ts` (`searchContent`,
`searchFiles`, `guardedEntries`), `src/core/concurrency.ts`
(`StopReasonTracker`), `src/core/glob.ts` (`globEntries` `onlyFiles`),
`src/core/read.ts` (mode builders), `src/core/util.ts` (caps and timeout).

**Not audited**: the other ~1640 unchanged lines of `__tests__/tools.test.ts`;
`src/core/page-store.ts` beyond the snapshot contract; the ten tools this diff
does not touch. All out of the changed set and its blast radius.

**Taken on trust**: `zod/v4` optional-field inference; that clients discard
`text` when `structuredContent` is present — asserted by
[`text-first-results.plan.md`](text-first-results.plan.md) against Claude Code
2.1.261 and not re-verified here.

**Tells resolved**: `tools.test.ts:324` (`SECRET`) is a pre-existing test
fixture outside the diff; `search-content.ts:94` (`MARKER`) is a Zod
`examples` array, not a TODO.
