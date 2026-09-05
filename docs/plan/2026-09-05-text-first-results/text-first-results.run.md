# Run: Text-shaped tool results reach the model as text in Claude Code

Executing [`text-first-results.plan.md`](text-first-results.plan.md), started
2026-09-05 at `a7aa52d0`.

- **Orient** 2026-09-05 — done. Drift check empty; `HEAD` at `a7aa52d0`; every
  Current state excerpt matched its file.
- **1** 2026-09-05 — **STOP**: the Current state inventory of text-supplying
  tools is wrong, and step 1's Verify failed. `node scripts/tasks.mjs --quick`
  → exit 0, but `node scripts/tasks.mjs test` → `tests 271 / pass 237 /
  fail 34`, across tools the plan says are unaffected.

## STOP at step 1

**Condition**: two of the plan's own, together.

1. "The code at a [Current state](text-first-results.plan.md#current-state)
   location does not match its excerpt."
2. Step 1's Verify: "failures only in the assertions listed under Current state
   ... and in `TOOL-SURFACE-001`; **nothing else**."

**Evidence**. The plan's `define.ts:95-99` bullet names the text-supplying
tools as eight: "`delete-file`, `diff`, `edit`, `list`, `move`, `patch`,
`read`, `stat`". The repo has **thirteen**. The five the plan missed:

| Tool                       | Supplies `text` at                                             |
| :------------------------- | :------------------------------------------------------------- |
| `list_roots`               | [`roots.ts:34`](../../../src/tools/roots.ts#L34)                |
| `create`                   | [`create.ts:165,168`](../../../src/tools/create.ts#L165)        |
| `replace_text`             | [`replace-in-files.ts:691,693`](../../../src/tools/replace-in-files.ts#L691) |
| `search_text`              | [`search-content.ts:467`](../../../src/tools/search-content.ts#L467) |
| `find_files`               | [`search-files.ts:248`](../../../src/tools/search-files.ts#L248) |

All five build the key as `const text = ...` and return `{ structured, text }`,
which is why a grep for a `text:` property missed them.

**Three consequences, each fatal to a different part of the plan.**

1. `replace_text` keeps `publishOutputSchema: true`
   ([`replace-in-files.ts:664`](../../../src/tools/replace-in-files.ts#L664))
   because Scope declares it "supplies no `text`; keeps `outputSchema` and
   `structuredContent`, unchanged". It does supply `text`, so it now publishes
   an `outputSchema` and returns no `structuredContent` — the precise failure
   the plan's own Current state warns about. `TC-FUNC-013r` fails with
   `result.isError === true`
   ([`tools.test.ts:1133`](../../../__tests__/tools.test.ts#L1133)).
2. Step 5's instructions rewording says `nextCursor` "appears in the text
   (list) or `structuredContent` (`find_files`, `search_text`)". Both of those
   supply text, so both now ship `nextCursor` under `_meta`. The replacement
   line would ship a false statement to every client.
3. Step 2's `TC-FUNC-073` is built on the same false premise — "call
   `find_files` ... assert the find_files result has `structuredContent`
   defined". It cannot pass as written.

**The 34 failures** are the listed assertions plus every test touching those
five tools: `SMOKE-004`, `TC-FUNC-052` (`list_roots`); `TC-FUNC-014`,
`find_files pages are stable` (`find_files`); `TC-FUNC-072`, `search_text pages
are stable` (`search_text`); `TC-FUNC-013r` (`replace_text`); `TC-FUNC-064`
through `TC-FUNC-071` (choice round-trips through `create`/`move`/`delete`);
`INSP-CFG-002`, `INSP-STDIO-004`, `INSP-STDIO-009`, `STDIO-012`, `HTTP-004`.

**Working tree**: step 1's code edits are applied and left in place —
`define.ts` (the `_meta` rule, correct as written), `publishOutputSchema`
removed from `read.ts`/`edit.ts`/`delete-file.ts`, and `stat.ts`'s text summary
plus its `formatBytes` import removed. The rule itself is not what broke; its
blast radius was mis-scoped. `git checkout -- src/` reverts all of it.

**Hands to**: [write-plan](text-first-results.plan.md) — re-inventory the
text-supplying tools from a grep that catches `const text = ...`, then rework
Scope (`replace_text` moves in and loses `publishOutputSchema`, or keeps both
by keeping `structuredContent`), the step 5 instructions wording, and
`TC-FUNC-073`'s data-tool half. `list_roots` and `create` need a decision the
plan never faced: their text is a summary, not a document, so they may belong
with `stat` as data tools instead.

## Resume 2026-09-05, after the plan was corrected

Decisions from the user: `replace_text` moves in scope and drops its
`outputSchema`; `list_roots` and `create` become data tools. Plan updated
accordingly, then re-run from step 1.

- **1** 2026-09-05 — done. `--quick` → exit 0; `test` → `pass 242 / fail 29`,
  all 29 in the listed set, and every "must still pass" row green
  (`SMOKE-004`, `TC-FUNC-052`, `INSP-CFG-002`, `INSP-STDIO-004`,
  `TC-FUNC-015s`, `TC-FUNC-013r`).
- **2** 2026-09-05 — done. `node scripts/tasks.mjs test` → `pass 272`, `fail 0`.
- **3** 2026-09-05 — done. `node scripts/tasks.mjs test` → `pass 273`, `fail 0`.
- **4** 2026-09-05 — done. `node scripts/tasks.mjs test` → `pass 274`, `fail 0`.
- **5** 2026-09-05 — done. `node scripts/tasks.mjs` → exit 0, `pass 274`.
- **6** 2026-09-05 — done. Headless `claude -p` probe: the `read` tool_result
  text begins `# filesystem-mcp` and the `list` tool_result text begins
  `src\n├──`. Both render as text, neither as JSON.

## Done

- [x] `node scripts/tasks.mjs` exits 0.
- [x] `node scripts/tasks.mjs test` → `tests 274 / pass 274 / fail 0`, with
      `TC-FUNC-073`, `TC-FUNC-074` and `TC-FUNC-075` all passing.
- [x] Step 6 shows file text and tree in the Claude Code tool results.
- [ ] **Deviation.** `git status` lists two files outside the plan's Scope:
      [`src/core/fmt.ts`](../../../src/core/fmt.ts) and
      [`src/core/util.ts`](../../../src/core/util.ts). Dropping `stat`'s and
      `create`'s text summaries left `formatBytes` with no callers, and `knip`
      fails the static gate on an unused export. `formatBytes` was deleted,
      which orphaned `GIB` (deleted) and un-exported `KIB` (still used inside
      `util.ts`). Forced by the plan's own gate, not a scope choice — but the
      plan should have named it.

## Notes review

- **Trailer must never read as file bytes.** Held. `readTrailer`
  ([`read.ts:341-362`](../../../src/tools/read.ts#L341)) emits every line `//`
  prefixed and separates it from the content with exactly one blank line,
  picking `\n` or `\n\n` by whether the content already ends in a newline.
  `TC-FUNC-074` asserts the file's own lines precede the trailer unaltered.
- **No `FS_*` switch to keep `structuredContent`.** Held; nothing was added.
- **`resource_link` blocks stay.** Held;
  [`file-uri.ts`](../../../src/core/file-uri.ts) untouched, and `git status`
  confirms it.
- **Rollback** is still a single `git revert` of the landing commit.
