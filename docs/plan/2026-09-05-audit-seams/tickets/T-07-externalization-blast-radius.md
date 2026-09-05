---
kind: frontier-ticket
id: T-07
title: Which tests, docs, and schema texts encode the three externalization rules?
map: M-01
status: closed
type: research
priority: 30
blocked_by: []
claimed:
---

## Question

The exact blast radius of unifying the externalization trigger across `list`,
`search_files`, `search_text` and retiring `FS_MAX_INLINE_MATCHES`: every test
that pins the current per-tool rule, and every prose, schema description, or
help text that states it.

## Research context

- Unblocks:
  [Own page replay and the externalization trigger in core/cursor.ts; retire FS_MAX_INLINE_MATCHES](T-05-cursor-owns-replay.md)
  — its file list and which tests must be rewritten versus left green.
- Starting sources, all under `C:\filesystem-mcp`:
  - Current rules: `src/tools/list.ts:322` (externalize on hard-cap overflow
    only), `src/tools/search-files.ts:178-181` (on `results > maxResults ||
    summary.truncated`), `src/tools/search-content.ts:72-79,296-310` (on
    `page.length > FS_MAX_INLINE_MATCHES`, per page including continuation).
  - Tests: grep `__tests__/**/*.test.ts` for `resourceUri`, `nextCursor`,
    `truncated`, `MAX_INLINE_MATCHES`, `FS_MAX_INLINE_MATCHES`, `maxEntries`,
    `maxResults`; open each hit and classify which tool and which rule it pins
    (first-page-only, hard-cap-only, per-page externalize, inline slice to 50).
  - Prose and schema text: `src/tools/list.ts:206-243`,
    `src/tools/search-files.ts:60-80`, `src/tools/search-content.ts:130-160`,
    `src/instructions.ts`, `README.md` (grep `resourceUri`, `nextCursor`,
    `MAX_INLINE_MATCHES`, `hard cap`, `first page`), `src/cli-help.ts:121`.
  - Env plumbing: where `parseEnvInt('FS_MAX_INLINE_MATCHES', …)` is read and
    whether any test sets that env var.
- Return, with `file:line` for each: (a) tests that will fail under the "any
  incompleteness, first page only" rule and what each asserts today; (b) tests
  that already assert that rule and should stay untouched; (c) every text
  string that must be rewritten, quoted; (d) every read of
  `FS_MAX_INLINE_MATCHES` and every doc mention.
- Scope: read-only; no edits. Evidence is `file:line` only.

## Resolution

Classification: Decided (research return, citations opened and checked 2026-09-05).

**(a) Tests that fail under "any incompleteness, first page only"** — exactly one: `__tests__/tools.test.ts:775-801` `TC-FUNC-063`, which lists with `maxEntries: 2` over 4 files and asserts at `:790-794`
`assert.strictEqual(s1.resourceUri, undefined, 'ordinary pagination must not externalize a hard-cap resource')`.
Under rule B the first page carries `resourceUri`; the assertion inverts. No test sets `FS_MAX_INLINE_MATCHES`, pins the inline slice to 50, or pins per-page minting on `search_text` continuation.

**(b) Tests already asserting the target rule — leave untouched** — `tools.test.ts:1249-1285` (`find_files`: URI on first page `:1261`, absent on continuation `:1276-1283`); `:836-864` (list replay after directory removal, no URI assertion); `:1369-1406` (`search_text` cursor stability, no externalization assertion); `:804-825` and `__tests__/stdio.test.ts:145-152` (cursor transport only).

**(c) Text to rewrite** —
- `src/tools/list.ts:209` "…resourceUri is only for hard-cap overflow."
- `src/tools/list.ts:239-242` "…first page only, when total entries exceed the hard cap…"
- `src/tools/list.ts:365-366` tool description "…resourceUri is only for hard-cap overflow."
- `src/tools/list.ts:387-397` trailer comment/text "truncated: N of M entries shown; full tree at …" — keep the trailer, fix its trigger wording.
- `src/tools/search-files.ts:68-73` "…first page only, when results are paginated" — compatible; clarify to include cap truncation.
- `src/tools/search-files.ts:177-179` comment describing the split rule.
- `src/tools/search-content.ts:141` "True when the match list was cut due to maxResults or timeout" (owned by T-06).
- `src/tools/search-content.ts:149-151` "…present when matches exceed the inline limit".
- `src/instructions.ts:70-71` already says "resourceUri appears on the first page only" — **stays**.

**(d) `FS_MAX_INLINE_MATCHES`** — one runtime read, `src/tools/search-content.ts:42`; help `src/cli-help.ts:121-122`; docs `README.md:405`. `CHANGELOG.md:168` is a historical rename table (`FS_CONTEXT_MAX_INLINE_MATCHES` → `FS_MAX_INLINE_MATCHES`) — release history, leave it.

**(e) Where `truncated` comes from** — `list`: only inside the stored full-tree resource (`list.ts:324-330`), not on the inline page. `find_files`: **no `truncated` output field** (`search-files.ts:55-74`); incompleteness rides `resourceUri`/`nextCursor`/`stoppedReason`; the engine's `summary.truncated` (`core/search.ts:260-263`) is internal. `search_text`: engine value at `search-content.ts:402-404`, then overwritten to `true` by the inline slice at `:276-280` and `:305-308` — two meanings today.

Material uncertainty: `search_text`'s per-continuation-page minting (`search-content.ts:375-379`) is implementation-only, untested; T-05's red-first regression is new coverage, not a rewrite.