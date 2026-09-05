# Plan: Text-shaped tool results reach the model as text in Claude Code

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `a7aa52d0`, 2026-09-05.
> **Drift check (run first)**: `git diff --stat a7aa52d0..HEAD -- src/tools/define.ts src/tools/read.ts src/tools/list.ts src/tools/stat.ts src/tools/edit.ts src/tools/delete-file.ts src/core/read.ts src/instructions.ts __tests__/`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

Claude Code (verified on 2.1.261) drops every `text` content block from an MCP
tool result whenever `structuredContent` is present, and shows the model
`JSON.stringify(structuredContent)` instead. Eight tools here supply a
model-facing `text` (file bytes, ASCII tree, unified diff, one-line summaries)
and a metadata-only `structuredContent`. In Claude Code the model therefore
never sees the file a `read` returned, nor the tree from `list`, and falls back
to one `resources/read` round trip per file. Measured in session
`768724c4-a9f9-47dd-bd5b-ecb93d4c03aa`: 3 dead `read` calls, 14 fallback
resource reads, `list` at 3.9x the size of its tree.

After this lands, a tool that supplies `text` ships its structured half under
`_meta` instead of `structuredContent`. Claude Code then renders the text
(verified by a headless run against a patched `dist/`), programmatic clients
still get the metadata, and the two facts the model needs from that metadata
(read continuation, list `nextCursor`) ride in the text as a trailer.

Requirements covered: none, this is a fix.

## Current state

- [`src/tools/define.ts:250-264`](../../../src/tools/define.ts#L250-L264) —
  the one place every success result is assembled. Its comment states the
  assumption Claude Code breaks:

  ```ts
  /**
   * The spec asks a structured result to *also* carry the JSON as a text block,
   * for clients that read only `content`. Where a tool supplies its own `text`
   * (list's ASCII tree, read's file) that serves such a client better, so it
   * wins; tools with no `text` still fall back to the JSON.
   */
  function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
    const text = result.text ?? JSON.stringify(result.structured);
    const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
    return {
      content,
      structuredContent: result.structured,
      ...(isTotalBatchFailure(result.structured) ? { isError: true } : {}),
    };
  }
  ```

- [`src/tools/define.ts:95-99`](../../../src/tools/define.ts#L95-L99) —
  `RunResult<T>` is `{ structured: T; text?: string; resources?: ContentBlock[] }`.
  `text` present is the exact signal "this tool authored a model-facing text".
  **Thirteen** tools supply it. Verify the list before trusting it — a grep for
  a `text:` property finds only eight, because five build the key as
  `const text = ...` and return `{ structured, text }`. Use
  `grep -nE "text[,:}]" src/tools/*.ts`:

  | Tool                     | Supplies `text` at                                                           | After this plan |
  | :----------------------- | :--------------------------------------------------------------------------- | :-------------- |
  | `read`                   | [`read.ts:540`](../../../src/tools/read.ts#L540)                              | `_meta`         |
  | `list`                   | [`list.ts:389`](../../../src/tools/list.ts#L389)                              | `_meta`         |
  | `diff`                   | [`diff.ts:97`](../../../src/tools/diff.ts#L97)                                | `_meta`         |
  | `patch`                  | [`patch.ts:158,183`](../../../src/tools/patch.ts#L158)                        | `_meta`         |
  | `edit`                   | [`edit.ts:584`](../../../src/tools/edit.ts#L584)                              | `_meta`         |
  | `delete`                 | [`delete-file.ts:452,461`](../../../src/tools/delete-file.ts#L452)            | `_meta`         |
  | `move`                   | [`move.ts:461`](../../../src/tools/move.ts#L461)                              | `_meta`         |
  | `replace_text`           | [`replace-in-files.ts:691,693`](../../../src/tools/replace-in-files.ts#L691)  | `_meta`         |
  | `search_text`            | [`search-content.ts:467`](../../../src/tools/search-content.ts#L467)          | `_meta`         |
  | `find_files`             | [`search-files.ts:248`](../../../src/tools/search-files.ts#L248)              | `_meta`         |
  | `stat`                   | [`stat.ts:271`](../../../src/tools/stat.ts#L271)                              | text dropped    |
  | `create`                 | [`create.ts:165,168`](../../../src/tools/create.ts#L165)                      | text dropped    |
  | `list_roots`             | [`roots.ts:34`](../../../src/tools/roots.ts#L34)                              | text dropped    |

  The three in the last group are **data tools**: their `text` is a lossy
  one-line summary of a result whose value is the metadata (`stat`'s
  `tokenEstimate`, `create`'s per-path outcome, `list_roots`' roots). Dropping
  it lets `define.ts` render the JSON and keeps `structuredContent`, which is
  what a caller of those three actually wants. Every other tool's `text` is the
  document itself, so it stays and the metadata moves to `_meta`.

  `auth_probe` ([`tools.test.ts:287`](../../../__tests__/tools.test.ts#L287)) is
  a test-local tool that supplies no `text`; it keeps `structuredContent` and
  needs no change.

- [`src/tools/define.ts:556-563`](../../../src/tools/define.ts#L556-L563) —
  `outputSchema` reaches the wire only when `publishOutputSchema` is set. Per
  MCP, a tool that publishes `outputSchema` must return `structuredContent`;
  Claude Code enforces it (`Output validation error: Tool read has an output
  schema but no structuredContent`, observed). Publishers today:
  [`read.ts:397`](../../../src/tools/read.ts#L397),
  [`edit.ts:529`](../../../src/tools/edit.ts#L529),
  [`delete-file.ts:423`](../../../src/tools/delete-file.ts#L423),
  [`replace-in-files.ts:664`](../../../src/tools/replace-in-files.ts#L664).
  **All four supply `text`**, so all four lose the line — after this plan no
  tool publishes an `outputSchema` at all.

- [`src/tools/read.ts:514-546`](../../../src/tools/read.ts#L514-L546) — text
  assembly. Single path: bare file content. Batch: `// <path>` header per
  file, blank line between. `structuredResults` strips `content` and keeps
  `continuation`, `totalLines`, `linesRead`, `hasMoreLines`, `contentHash`,
  `resourceUri`. None of those reach the text today.

- [`src/tools/read.ts:159-189`](../../../src/tools/read.ts#L159-L189) —
  `buildReadContinuation()` returns `{ tool: 'read', args: { path, startLine,
  endLine }, hint }`. `hint` has two forms
  ([`:180-182`](../../../src/tools/read.ts#L180-L182)), but only one is
  reachable: `totalLines` is assigned in exactly one place,
  [`core/read.ts:669-677`](../../../src/core/read.ts#L669-L677) (`readFull`),
  whose same object literal pins `hasMoreLines: false`. The three modes that
  can set `hasMoreLines: true` — `readHead`, `readRange`, `readTail` — never
  set `totalLines`, and nothing enriches it downstream. So a continuation's
  `hint` is **always** `File was truncated. Read next chunk with these args.`;
  the `N lines remain (a-b)` form never fires. Step 3 must not illustrate it.
  `linesRead` *is* populated in every mode.

- [`src/tools/read.ts:303-340`](../../../src/tools/read.ts#L303-L340) —
  `buildPerPathReadValue()` is where `continuation` and `contentHash` are
  computed per path; `PerPathReadValue` carries them alongside `content`.

- [`src/tools/list.ts:263-279`](../../../src/tools/list.ts#L263-L279) —
  `listOutput()` puts `nextCursor` and `resourceUri` in the structured half only.
  [`list.ts:384-393`](../../../src/tools/list.ts#L384-L393) returns
  `{ structured, text: markdown, resources? }`; `markdown` is the tree from
  `renderMarkdown()` at [`list.ts:160`](../../../src/tools/list.ts#L160).

- [`src/tools/stat.ts:248-276`](../../../src/tools/stat.ts#L248-L276) — `text`
  is a lossy one-liner per path (`AGENTS.md: file, 751 B`); the structured half
  carries `tokenEstimate`, `modified`, `mimeType`, `isHidden`. For the model the
  JSON is the useful view, so `stat` is treated as a data tool: its `text` is
  removed and `define.ts` falls back to the JSON text. `stat` supplies `text`
  **unconditionally** ([`:271`](../../../src/tools/stat.ts#L271)), so step 1
  would flip it to `_meta` and break four stat assertions the moment it lands.
  That is why dropping the text is part of step 1 and not a later step.

- [`src/instructions.ts:72-73`](../../../src/instructions.ts#L72-L73) — server
  instructions say `When a tool returns resourceUri, call resources/read` and
  `nextCursor is backed by a snapshot`. Both stay true; wording must say where
  they now appear (text trailer / `_meta` / `resource_link`).

- Tests asserting `structuredContent` on text-supplying tools (all become
  `_meta`):
  [`tools.test.ts:100`](../../../__tests__/tools.test.ts#L100) read,
  [`:406`](../../../__tests__/tools.test.ts#L406) delete,
  [`:464`](../../../__tests__/tools.test.ts#L464) read,
  [`:671`](../../../__tests__/tools.test.ts#L671) diff,
  [`:713,729,744,757`](../../../__tests__/tools.test.ts#L713) list,
  [`:832,856,880,905`](../../../__tests__/tools.test.ts#L832) move,
  [`:928,959`](../../../__tests__/tools.test.ts#L928) delete,
  [`:1049,1104`](../../../__tests__/tools.test.ts#L1049) move,
  [`:1112`](../../../__tests__/tools.test.ts#L1112) read,
  [`:1206,1226,1247`](../../../__tests__/tools.test.ts#L1206) stat — stays
  `structuredContent` (stat no longer supplies text),
  [`:1320,1329`](../../../__tests__/tools.test.ts#L1320) list;
  [`stdio.test.ts:128,137`](../../../__tests__/stdio.test.ts#L128) list;
  [`http-server.test.ts:79-81`](../../../__tests__/http-server.test.ts#L79) diff;
  [`subscriptions-listen.test.ts:435-436`](../../../__tests__/subscriptions-listen.test.ts#L435) diff;
  [`inspector-stdio.test.ts:199-215`](../../../__tests__/inspector-stdio.test.ts#L199) stat — stays;
  [`inspector-stdio.test.ts:277-299`](../../../__tests__/inspector-stdio.test.ts#L277) — read
  through the Inspector CLI, `structuredContent.results[0].error.code` becomes
  `_meta.results[0].error.code`.
  [`tools.test.ts:788`](../../../__tests__/tools.test.ts#L788) asserts
  `structuredContent === undefined` on an *error* result and is untouched.

- Tests that read `structuredContent` **through a helper**, so they do not
  appear in a grep for the field.
  [`__tests__/helpers.ts:495-501`](../../../__tests__/helpers.ts#L495-L501):

  ```ts
  /** Structured per-path failure summary from a read/search tool result. */
  export function failedSummary(result: { structuredContent?: unknown }):
  ...
    return result.structuredContent as
  ```

  The parameter is optional, so repointing the tools without repointing this
  keeps compiling and returns `undefined` at run time. Six live call sites, all
  on `read` results — `read` supplies `text` on every path, including the
  all-paths-failed one
  ([`read.ts:514-520`](../../../src/tools/read.ts#L514-L520)), so no result
  shape escapes:
  [`tools.test.ts:392`](../../../__tests__/tools.test.ts#L392) TC-FUNC-015,
  [`:419`](../../../__tests__/tools.test.ts#L419) TC-FUNC-017,
  [`:439`](../../../__tests__/tools.test.ts#L439) TC-FUNC-021,
  [`:481`](../../../__tests__/tools.test.ts#L481),
  [`:493`](../../../__tests__/tools.test.ts#L493),
  [`http-transport.test.ts:73`](../../../__tests__/http-transport.test.ts#L73)
  HTTP-004.

- [`__tests__/tools.test.ts:1358-1380`](../../../__tests__/tools.test.ts#L1358-L1380)
  — `TOOL-SURFACE-001` pins which tools publish `outputSchema`: asserts
  `create`, `patch`, `stat` do not, and inspects `edit`'s. Must be re-pinned.

- Conventions: batch text tokens joined with ` · ` as in
  [`edit.ts:489-515`](../../../src/tools/edit.ts#L489-L515); every tool test is
  an `it('TC-FUNC-NNN: ...')` inside
  [`tools.test.ts`](../../../__tests__/tools.test.ts) using
  `harness.client.callTool` and `firstTextBlock(result)`.

- Verified facts this plan rests on (headless `claude -p --mcp-config` runs
  against a temporarily patched `dist/tools/define.js`, 2026-09-05):
  - `structuredContent` present ⇒ model sees JSON only, links kept.
  - `structuredContent` absent, `_meta` carries the same object ⇒ model sees
    the text blocks verbatim; `_meta` is not shown to the model.
  - `outputSchema` published without `structuredContent` ⇒ client-side error.

## Commands

| Purpose            | Command                              | Expected on success                      |
| ------------------ | ------------------------------------ | ---------------------------------------- |
| Static checks      | `node scripts/tasks.mjs --quick`     | ends `All matched files use Prettier code style!`, exit 0 |
| Tests              | `node scripts/tasks.mjs test`        | `ℹ pass 271` (+ new), `ℹ fail 0`         |
| Full gate          | `node scripts/tasks.mjs`             | exit 0                                   |
| Build for CC probe | `npm run build`                      | exit 0, `dist/tools/define.js` updated   |

Baseline at `a7aa52d0`: quick check passes, `tests 271 / pass 271 / fail 0`.

## Scope

**In scope** — the only files to modify:

- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/list.ts`](../../../src/tools/list.ts)
- [`src/tools/stat.ts`](../../../src/tools/stat.ts)
- [`src/tools/create.ts`](../../../src/tools/create.ts) — data tool: text dropped
- [`src/tools/roots.ts`](../../../src/tools/roots.ts) — data tool: text dropped
- [`src/tools/edit.ts`](../../../src/tools/edit.ts) (one line)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) (one line)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts) (one line)
- [`src/instructions.ts`](../../../src/instructions.ts)
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) (one line)
- [`__tests__/http-transport.test.ts`](../../../__tests__/http-transport.test.ts)
  — only if the `failedSummary` signature change leaves it uncompiling; the
  one-line helper fix should cover its single call site untouched.
- [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts)
- [`__tests__/http-server.test.ts`](../../../__tests__/http-server.test.ts)
- [`__tests__/subscriptions-listen.test.ts`](../../../__tests__/subscriptions-listen.test.ts)
- [`__tests__/inspector-stdio.test.ts`](../../../__tests__/inspector-stdio.test.ts)
- [`CHANGELOG.md`](../../../CHANGELOG.md)

**Files out of scope** — leave alone even though they look related:

- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts),
  [`search-files.ts`](../../../src/tools/search-files.ts) — both supply `text`
  and publish no `outputSchema`, so the `define.ts` rule moves them to `_meta`
  with no per-tool edit. Their *tests* are in scope (step 2).
- [`src/tools/diff.ts`](../../../src/tools/diff.ts),
  [`patch.ts`](../../../src/tools/patch.ts),
  [`move.ts`](../../../src/tools/move.ts) — already supply `text`; the
  `define.ts` rule covers them with no per-tool edit.
- [`src/core/file-uri.ts`](../../../src/core/file-uri.ts) — the
  `resource_link` `audience` annotation is irrelevant: Claude Code renders every
  link as `[Resource link: NAME] URI` regardless of audience (verified in the
  2.1.261 binary). Do not touch.
- [`package.json`](../../../package.json), [`server.json`](../../../server.json)
  — versions are bumped by the Release workflow only.
- [`README.md`](../../../README.md) — does not document result shapes.

## Steps

### 1. Route the structured half to `_meta`, and drop `stat`'s text

In [`define.ts:256-264`](../../../src/tools/define.ts#L256-L264) replace the
body of `buildSuccessResponse` so `structuredContent` is emitted only when the
tool supplied no `text`; otherwise the same object goes under `_meta`:

```ts
function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
  const hasText = result.text !== undefined;
  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
  return {
    content,
    ...(hasText
      ? { _meta: result.structured as Record<string, unknown> }
      : { structuredContent: result.structured }),
    ...(isTotalBatchFailure(result.structured) ? { isError: true } : {}),
  };
}
```

Replace the doc comment above it with the fact: Claude Code (and any client
that treats `structuredContent` as the canonical model view) discards `text`
blocks when `structuredContent` is present, so a tool that authored a text
result ships its metadata under `_meta` instead. Leave `isTotalBatchFailure`
and `completeProgress(result.structured)` untouched; both read the in-memory
`structured`, not the wire field.

Remove the `publishOutputSchema: true` line and its comment at
[`read.ts:394-397`](../../../src/tools/read.ts#L394-L397),
[`edit.ts:528-529`](../../../src/tools/edit.ts#L528-L529),
[`delete-file.ts:421-423`](../../../src/tools/delete-file.ts#L421-L423), and
[`replace-in-files.ts:664`](../../../src/tools/replace-in-files.ts#L664). All
four supply `text`, so all four would otherwise publish an `outputSchema` while
returning no `structuredContent` — the error the Goal cites. No tool publishes
one after this.

Then make the three data tools, in this same step — delete each one's `text`
computation and the `text,` key in its return, so `define.ts` falls back to the
JSON and each keeps `structuredContent`:

- [`stat.ts:248-276`](../../../src/tools/stat.ts#L248-L276). Also remove the
  `formatBytes` import at [`stat.ts:8`](../../../src/tools/stat.ts#L8); line
  257 is its only use.
- [`create.ts:165,168`](../../../src/tools/create.ts#L165) — both return sites,
  and whatever builds `summary` if nothing else uses it.
- [`roots.ts:28-34`](../../../src/tools/roots.ts#L28-L34) — the `const text =`
  ternary and the `text` key in `Promise.resolve({ structured, text })`.

> These cannot wait for a later step. All three supply `text`
> unconditionally, so the moment the `define.ts` rule lands they ship `_meta`
> and the assertions steps 2-4 are told to leave alone start failing — making
> every `fail 0` gate between here and there unreachable. This is what the
> 2026-09-05 run hit; see [`text-first-results.run.md`](text-first-results.run.md).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0 (lint catches the unused
`formatBytes` import if it was missed).
`node scripts/tasks.mjs test` → failures only in the assertions listed under
Current state for read, delete, diff, list, move, `find_files` and
`search_text` — including the six `failedSummary` sites — and in
`TOOL-SURFACE-001`; nothing else.

These must **still pass**; each failure names the data-tool edit that was
missed:

| Failing test                                          | Means      |
| :---------------------------------------------------- | :--------- |
| `TC-FUNC-015s`, `INSP-STDIO-002`                       | `stat`     |
| `SMOKE-004`, `TC-FUNC-052`, `INSP-CFG-002`, `INSP-STDIO-004` | `list_roots` |
| any `create` case                                      | `create`   |
| `TC-FUNC-013r`                                         | `replace_text` still publishes `outputSchema` |

### 2. Repoint tests from `structuredContent` to `_meta`

Mechanical: at every line listed under Current state for read, delete, diff,
list, move (not stat), change `result.structuredContent` to `result._meta`
(the SDK client passes `_meta` through on `CallToolResult`). Same change at the
`find_files` and `search_text` sites, which the Current state inventory missed
because both tools were mis-classified:
[`tools.test.ts:1145`](../../../__tests__/tools.test.ts#L1145),
[`:1158`](../../../__tests__/tools.test.ts#L1158),
[`:1175`](../../../__tests__/tools.test.ts#L1175) find_files;
[`:1265`](../../../__tests__/tools.test.ts#L1265),
[`:1280`](../../../__tests__/tools.test.ts#L1280),
[`:1293`](../../../__tests__/tools.test.ts#L1293) search_text.
`replace_text` needs none — `TC-FUNC-013r` asserts only `isError` and the file
on disk. In
[`inspector-stdio.test.ts:277-299`](../../../__tests__/inspector-stdio.test.ts#L277-L299)
change the `executeInspectorCli<{ structuredContent?: ... }>` generic and the
read at `:298` to `_meta`. Leave the stat cases
([`tools.test.ts:1206,1226,1247`](../../../__tests__/tools.test.ts#L1206),
[`inspector-stdio.test.ts:199-215`](../../../__tests__/inspector-stdio.test.ts#L199))
and [`tools.test.ts:788`](../../../__tests__/tools.test.ts#L788) as they are.
Leave the `list_roots` sites too — it is a data tool now:
[`tools.test.ts:499`](../../../__tests__/tools.test.ts#L499),
[`smoke.test.ts:49`](../../../__tests__/smoke.test.ts#L49),
[`inspector-config.test.ts:59,74`](../../../__tests__/inspector-config.test.ts#L59),
[`inspector-stdio.test.ts:114,129`](../../../__tests__/inspector-stdio.test.ts#L114).
Same for `auth_probe` at
[`tools.test.ts:338,359`](../../../__tests__/tools.test.ts#L338).

Repoint the helper too — one line at
[`helpers.ts:501`](../../../__tests__/helpers.ts#L501), `result.structuredContent`
to `result._meta`, and the parameter type at
[`:495`](../../../__tests__/helpers.ts#L495) to `{ _meta?: unknown }`. That
covers all six call sites (five in `tools.test.ts`, one in
`http-transport.test.ts`) without touching them. `failedSummary` is only ever
handed `read` results, so no caller needs the old field back; the parameter is
optional, so leaving it would compile and fail six assertions at run time
instead.

In `TOOL-SURFACE-001`
([`tools.test.ts:1358-1380`](../../../__tests__/tools.test.ts#L1358-L1380)):
replace the `['create', 'patch', 'stat']` loop with one over **every** tool —
no tool publishes an `outputSchema` any more, so iterate `tools` directly and
assert `tool.outputSchema === undefined` for each. Then delete the whole
`for (const name of ['edit'])` block
([`tools.test.ts:1367-1388`](../../../__tests__/tools.test.ts#L1367-L1388):
`$defs`, `date-time`, `02-29` assertions) — with no publishers left it would
assert on nothing. Update the comment above the loop; it currently says "Only
the three tools whose result shape is a union still publish an outputSchema".

Add one test beside `TC-FUNC-060` in
[`tools.test.ts`](../../../__tests__/tools.test.ts) — `TC-FUNC-073: text
tools ship metadata under _meta, data tools under structuredContent`: call
`read` on a small file and `stat` on the same file; assert the read result has
`structuredContent === undefined` and `_meta.summary.succeeded === 1`, and the
stat result has `_meta === undefined` and
`structuredContent.summary.succeeded === 1`.

> `stat` is the data-tool half, not `find_files` — `find_files` supplies `text`
> and is a `_meta` tool. Picking a text tool for this half is the mistake the
> 2026-09-05 run caught.

**Verify**: `node scripts/tasks.mjs test` → `ℹ pass 272`, `ℹ fail 0`.

### 3. `read`: continuation and hash trailer in the text

In [`read.ts:514-528`](../../../src/tools/read.ts#L514-L528), after the
per-path text is chosen, append a trailer for any path whose value carries
`continuation` or `contentHash`. One line each, `//` prefixed, separated from
the content by a blank line so it cannot be mistaken for file bytes:

```text
<file content>

// truncated: File was truncated. Read next chunk with these args. Continue: read {"path":"C:/x/big.ts","startLine":201,"endLine":400}
// sha256: 3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

Build the first line from `continuation.hint` and
`JSON.stringify(continuation.args)`; build the second from `contentHash`. For
the batch shape, place each file's trailer directly under that file's content,
before the blank line that precedes the next `// <path>` header.

> The hint above is the only one the code emits. Do not write the
> `N lines remain (a-b)` form into an expected output anywhere — see the
> `read.ts:159-189` bullet under [Current state](#current-state) for why that
> branch never fires. Changing `buildReadContinuation` to make it fire is out
> of scope.

A `tail` read sets `hasMoreLines` but gets no `continuation`
([`read.ts:308-310`](../../../src/tools/read.ts#L308-L310)), so the rule above
leaves a truncated tail read with no trailer at all — the model loses its only
in-text signal that lines were dropped. Cover it with one more line, keyed on
`hasMoreLines` where `continuation` is absent, built from `linesRead` (which
every mode populates, unlike `totalLines`):

```text
// truncated: showing last 20 lines
```

Add `TC-FUNC-074: read trailer carries continuation and hash` next to
`TC-FUNC-073`: write a 30-line file, call `read` with `head: 10,
includeHash: true`, assert `firstTextBlock(result).text` matches
`/^\/\/ truncated: .*"startLine":11,"endLine":20\}$/m` and
`/^\/\/ sha256: [0-9a-f]{64}$/m`, and that the first 10 lines precede the
trailer unchanged. Call `read` on the same file with no line params and assert
the text contains no `// truncated` and no `// sha256` line. Then call `read`
with `tail: 10` on the same file and assert the text matches
`/^\/\/ truncated: showing last 10 lines$/m` and carries no `Continue:` — that
is the branch with no `continuation` to build one from.

The `.*` in the first regex is deliberate: it spans the hint, which is a fixed
sentence the test has no reason to re-assert.

**Verify**: `node scripts/tasks.mjs test` → `ℹ pass 273`, `ℹ fail 0`.

### 4. `list`: `nextCursor` and overflow trailer in the text

In [`list.ts:384-393`](../../../src/tools/list.ts#L384-L393) append to
`markdown` before returning:

- when `structured.nextCursor` is set: `\n\nnextCursor: <cursor>` — the model
  passes it back verbatim as `cursor`;
- when `structured.resourceUri` is set (hard-cap overflow, first page only):
  `\n\ntruncated: <entryCount> of <totalEntries> entries shown; full tree at <resourceUri>`.

Add `TC-FUNC-075: list text carries nextCursor` next to `TC-FUNC-063`: create
4 files, `list` with `maxEntries: 2`, extract the cursor from the text with
`/^nextCursor: (\S+)$/m`, assert it equals `result._meta.nextCursor`, call
again with that cursor and assert the second page's text has no `nextCursor:`
line.

**Verify**: `node scripts/tasks.mjs test` → `ℹ pass 274`, `ℹ fail 0`.

### 5. Instructions and changelog

[`instructions.ts:72-73`](../../../src/instructions.ts#L72-L73): reword to
`ephemeral_results: When a result carries a resource_link or a resourceUri
(in structuredContent or _meta), call resources/read immediately — ...` and
`pagination: nextCursor appears in the text (list) or _meta (find_files,
search_text) and is backed by a snapshot on the same ~60s clock. ...`. Keep the
rest of each line verbatim.

[`CHANGELOG.md`](../../../CHANGELOG.md): add an `## [Unreleased]` section above
`## [2.0.0] - 2026-08-27` with a `### Changed` entry: tools that return a text
result (`read`, `list`, `diff`, `patch`, `edit`, `delete`, `move`,
`replace_text`, `search_text`, `find_files`) now ship their metadata under
`_meta` instead of `structuredContent`, so Claude Code renders the text; `read`
appends a `// truncated:` / `// sha256:` trailer and `list` a `nextCursor:`
line; no tool publishes an `outputSchema` any more; `stat`, `create` and
`list_roots` drop their one-line summary and return JSON text, keeping
`structuredContent`. Note the client-visible field move as a breaking change
for programmatic consumers.

**Verify**: `node scripts/tasks.mjs` → exit 0 (format check covers the
changelog table alignment).

### 6. End-to-end check in Claude Code

`npm run build`, then from a shell:

```bash
printf '{"mcpServers":{"fsprobe":{"type":"stdio","command":"node","args":["C:/filesystem-mcp/dist/index.js","C:/filesystem-mcp"]}}}' > /tmp/fsprobe.json
claude -p --mcp-config /tmp/fsprobe.json --strict-mcp-config --allowedTools "mcp__fsprobe__read,mcp__fsprobe__list" --output-format stream-json --verbose --model haiku "Call mcp__fsprobe__read with paths [\"C:/filesystem-mcp/AGENTS.md\"], then mcp__fsprobe__list with path C:/filesystem-mcp/src maxDepth 1. Reply done." < /dev/null | grep -o '"tool_result".\{0,120\}'
```

**Verify**: the `read` tool_result text begins `# filesystem-mcp` (file
content, not `{"results":`), and the `list` tool_result text begins
`src\n├──` (tree, not `{"path":`).

## Done

- [ ] `node scripts/tasks.mjs` exits 0
- [ ] `node scripts/tasks.mjs test` reports `pass 274`, `fail 0`, including
      `TC-FUNC-073`, `TC-FUNC-074`, `TC-FUNC-075`
- [ ] Step 6 shows file text and tree in the Claude Code tool results
- [ ] `git status` shows no modified files outside the in-scope list (plus
      this plan directory)

## STOP

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- A step's verification fails twice after one fix attempt.
- The fix appears to require an out-of-scope file — in particular, if the
  server SDK strips or rejects `_meta` on a `CallToolResult` (it did not in the
  2026-09-05 probe against `@modelcontextprotocol/server` in `node_modules`).
- Step 6 still shows JSON for `read` or `list`: the `_meta` assumption is
  wrong for the installed Claude Code version; report the version from
  `claude --version`.
- `TOOL-SURFACE-002` (tools/list budget) fails after step 1 — it should only
  get cheaper; a failure means something else changed the surface.

## Notes

- Reviewer focus: the trailer must never be mistaken for file bytes. The blank
  line plus `//` prefix is the only guard; do not drop either.
- Deliberately not done: an `FS_*` switch to keep `structuredContent` for
  clients that prefer it. `_meta` carries the same object, so nothing is lost
  for a programmatic consumer beyond the field name.
- The `resource_link` blocks (`[Resource link: NAME] URI`, ~80 chars per file
  in Claude Code) stay: they are the only carrier of the file URI now that
  `resourceUri` is off the model-visible surface, and subscriptions key on it.
- Rollback: `git revert` the landing commit; no data or schema migration.
