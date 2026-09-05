---
kind: frontier-ticket
id: T-05
title: Own page replay and the externalization trigger in core/cursor.ts; retire FS_MAX_INLINE_MATCHES
map: M-01
status: closed
type: task
priority: 30
blocked_by: [T-02, T-04, T-06, T-07]
claimed:
---

## Question

Deliver audit finding #1 as decided at charting, as one commit on `main`.

- Extend `src/core/cursor.ts` (owner of `createFirstPage`/`readNextPage`,
  lines 33-71) with one function that takes
  `{ store, queryKey, cursor, pageSize, produce }`, runs the replay-or-produce
  branch, applies the one externalization trigger — **any incompleteness**:
  `items.length > pageSize` OR the producer reports hard-cap truncation — and
  strips `resourceUri` from replayed metadata (first page only). Delete the
  three hand-rolled branches: `src/tools/list.ts:290-370`,
  `src/tools/search-files.ts:137-210`, `src/tools/search-content.ts:365-427`.
- `search_text` stops minting a resource per continuation page
  (`search-content.ts:375-378`, `finalizeSearchOutput`) — behavior change; a
  regression test proves the old behavior red first (`tdd`).
- Retire `FS_MAX_INLINE_MATCHES` as
  [Does retiring FS_MAX_INLINE_MATCHES ship as a MAJOR removal or a MINOR accept-and-ignore?](T-04-inline-matches-semver.md)
  decided: `CONFIG.MAX_INLINE_MATCHES` and `buildSearchPreviewState`'s slice
  (`search-content.ts:42,72-79`) go; the variable is read once at module load
  only to `Logger.warn` that it is ignored and `maxResults` sets the page
  size. `maxResults` is the only inline/page size.
- `search_text`'s `truncated` field means engine hard-cap or timeout only
  (`result.summary.truncated`, `search-content.ts:402-404`), per
  [What does search_text.truncated mean once the inline cap is gone?](T-06-search-text-truncated.md);
  the inline-slice assignments at `:276-280` and `:305-308` go with the slice,
  and the description at `:141` is rewritten to say paging is not truncation.
- Rewrite the text that encodes the old per-tool rules, per
  [Which tests, docs, and schema texts encode the three externalization rules?](T-07-externalization-blast-radius.md):
  `list.ts:209`, `:239-242`, `:365-366`, and the trailer wording at
  `:387-397`; `search-files.ts:68-73` and the comment at `:177-179`;
  `search-content.ts:149-151` (and `:141`, owned by T-06).
  `instructions.ts:70-71` already states first-page-only — leave it.
- One existing test flips: `__tests__/tools.test.ts:790-794` (`TC-FUNC-063`)
  asserts `resourceUri` is `undefined` on an ordinary two-page `list`; under
  the any-incompleteness rule the first page carries it. Rewrite that
  assertion (and its message) to the new rule; `tools.test.ts:1249-1285`,
  `:836-864`, `:1369-1406` already match and stay untouched.
- CHANGELOG: add `## [Unreleased]` with the `search_text` continuation change
  and the `list` first-page `resourceUri` change under `### Changed`, and
  `FS_MAX_INLINE_MATCHES` under `### Deprecated` naming `maxResults` as the
  replacement; mark the entries at `README.md:405` and `cli-help.ts:121-122`
  deprecated, pointing at `maxResults`. `CHANGELOG.md:168` is a historical
  rename table — leave it.
- Same cursors, same output field names; only the trigger and first-page rule
  change.

Priority 30: last in the landing order; the only behavior-changing task.

Completion per the map's execution contract: `node scripts/tasks.mjs` exits 0
on the landing commit; record in [`audit-seams.run.md`](../audit-seams.run.md).

## Resolution

Classification: **Delivered** under the map's execution contract.

- `src/core/cursor.ts` gains `paginate<T, M, R>({ store, queryKey, cursor,
  pageSize, produce, externalize? })` plus `ProducedPage`/`PaginatedPage`. A
  cursor replays via `readNextPage`; otherwise `produce()` runs the query,
  `createFirstPage` snapshots it, and when `items.length > pageSize ||
  truncated` the optional `externalize(items, metadata)` runs — first page
  only. Replayed pages carry no `resource` and mint nothing. `resourceUri` is
  no longer stored in any snapshot's metadata, so the first-page-only rule is
  structural rather than a strip on replay.
- `list.ts`, `search-files.ts`, `search-content.ts`: the three hand-rolled
  branches are gone; each hands `paginate` a `produce` (validate, scan, build
  metadata, report the engine's `truncated`) and an `externalize` (its
  `putJsonResource` call) and places `paged.resource?.entry.uri` on the
  output. `ListPageMetadata` and `SearchFilesPageMetadata` lose `resourceUri`;
  the three `*Output()` builders take `nextCursor` and `resourceUri` as
  arguments.
- `search-content.ts`: `CONFIG.MAX_INLINE_MATCHES`, `SearchPreviewState`,
  `buildSearchPreviewState`, `buildExternalizedResponse`, `finalizeSearchOutput`
  deleted. `FS_MAX_INLINE_MATCHES` is read once at module load only to
  `Logger.warn` (T-04). `truncated` comes solely from `result.summary.truncated`
  (T-06); schema text at the former `:141` and `:149-151` rewritten.
- Text rewritten: `list.ts` `maxEntries` description, `resourceUri`
  description, tool description, and the trailer (no longer says "truncated"
  for a paged list); `search-files.ts` `resourceUri` description (the
  split-rule comment went with the branch). `instructions.ts:70-71` untouched.
- Tests: `TC-FUNC-063` inverted (first page carries `resourceUri`, second does
  not); new `search_text externalizes the full match list on the first page
  only` (120 matches, `maxResults: 60`) — red under the old code on the
  continuation page, green now; also pins `truncated` absent when paging.
- CHANGELOG `## [Unreleased]`: `### Changed` (one trigger for three tools;
  `search_text` whole-page inline and `truncated` meaning), `### Deprecated`
  (`FS_MAX_INLINE_MATCHES`, naming `maxResults`). `README.md` and
  `cli-help.ts` entries marked deprecated. `CHANGELOG.md:168` untouched.
- Net: 9 files, +322 / −275 overall; source alone is a deletion
  (`search-content.ts` −75, `cursor.ts` +60, the other two neutral).

Completion check: red-first run → 2 fail; `node scripts/tasks.mjs` → exit 0,
274 pass / 0 fail, static gate clean. Evidence:
[`audit-seams.run.md`](../audit-seams.run.md), entry T-05. Commit `4c8dd15c`
on `main`.

Material uncertainty: none. One deviation: the landing commit's subject was
first written with a `!` breaking-change marker and amended to drop it, since
T-04 ruled this release non-major.