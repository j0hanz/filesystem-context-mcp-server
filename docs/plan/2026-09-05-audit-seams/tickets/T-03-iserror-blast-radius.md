---
kind: frontier-ticket
id: T-03
title: Which tests and call sites does the isError hand-off touch?
map: M-01
status: closed
type: research
priority: 20
blocked_by: []
claimed:
---

## Question

The exact blast radius of moving total-batch-failure detection out of
`define.ts`: every tool `run` that returns a batch shape `isTotalBatchFailure`
currently matches, and every test that asserts `isError` on a total or partial
batch failure.

## Research context

- Unblocks:
  [Hand total-batch-failure to batch.ts and drop the shape sniff in define.ts](T-02-iserror-handoff.md)
  — its file list and its "tests stay green unmodified" claim.
- Starting sources, all under `C:\filesystem-mcp`:
  - `src/tools/define.ts:219-244` (`isTotalBatchFailure`: the two shapes it
    matches — `summary.total/failed`, and `files|moves` + `failures` +
    `skipped`).
  - `src/tools/batch.ts` (`runOverPaths` → `BatchResult`; the pair-batch
    driver → `PairBatchOutcome`).
  - Every `src/tools/*.ts` whose `run` returns `structured` carrying `summary`,
    `files`, or `moves` — grep those keys and open each hit.
  - `__tests__/tools.test.ts` and any other `__tests__/*.test.ts` asserting
    `isError` — grep `isError` and open each hit to classify: total failure,
    partial failure, or non-batch error.
- Return, with `file:line` for each: (a) the list of tools whose `run` must
  set `isError`, and for each which of the two shapes it produces and the
  variable holding the counts at the return site; (b) the list of tests that
  pin `isError === true` on a total batch failure and `isError` absent/false on
  a partial one; (c) any tool whose structured output has `summary` **without**
  `total` (so the current sniff never fires for it) — `search_text`'s summary is
  suspected.
- Scope: read-only; no edits. Evidence is `file:line` only.

## Resolution

Classification: Decided (research return, citations opened and checked 2026-09-05).

**(a) Tools whose `run` must set `isError`** — seven, two shapes:

| Tool | Shape | Driver | Counts at return |
| :-- | :-- | :-- | :-- |
| `create` | `{ files, failures }` | `runOverPaths`, folded by hand | `create.ts:125-149` |
| `move`/`copy` | `{ moves, failures?, skipped? }` | pair driver (`batch.ts:121-125,267`) | `move.ts:303-317` |
| `read` | `{ results, summary }` | `runOverPaths` for survivors, summary rebuilt by hand | `read.ts:475-489,516-524` |
| `edit` | `{ results, summary: batch.summary }` | `runOverPaths` | `edit.ts:556-565,579-586` |
| `stat` | `{ results, summary: batch.summary }` | `runOverPaths` | `stat.ts:216-224,251-258` |
| `delete` | `{ results, summary }` | hand-built | `delete-file.ts:402-406` |
| `replace_text` | `{ results, summary }` | hand-built; `failures` array is capped, counts come from `failedFiles` | `replace-in-files.ts:499-525` |

`read`, `delete`, `replace_text` build `summary` themselves, so the `batch.ts` predicate must accept a bare `{ total, failed }` summary, not only a `BatchResult`.

**(b) Tests pinning the rule** — total failure → `isError === true`: `__tests__/tools.test.ts:148` (create), `:181` (move), `:479` (read, "no path succeeded, so the call failed"), `__tests__/http-transport.test.ts:72` (read over HTTP). Partial failure → not error: `tools.test.ts:165` (create), `:491` (read, "one path really was read"), `:1142` (move). `tools.test.ts:193` (delete) is a thrown-error path, not the batch detector.

**(c) Outputs the current sniff never matches** — `search_text` (`search-content.ts:60-68`) and `find_files` (`search-files.ts:100-121`) have no `summary`; no tool has top-level `failures` without `files`/`moves`/`skipped`. Nothing outside the seven is affected.

**(d) Other readers** — `failedSummary` (`__tests__/helpers.ts:495-507`) reads `_meta.results`/`summary.failed`, not `isError`; unaffected.

Material uncertainty: none material. Every batch-specific `isError` assertion is listed; the remaining ~55 `notStrictEqual(isError, true)` checks are generic success guards.