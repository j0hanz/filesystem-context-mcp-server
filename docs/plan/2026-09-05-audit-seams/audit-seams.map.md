---
kind: frontier-map
id: M-01
title: Land the three architecture-audit seams
status: open
created: 2026-09-05T21:34:00Z
---

## Destination

All three audit findings landed on `main`, each as its own revertable commit:
page-replay and the externalization trigger owned by `core/cursor.ts`;
total-batch-failure owned by `tools/batch.ts` with `define.ts` shape-agnostic;
`http-policy.ts` inside `src/transport/` with one JSON-RPC envelope builder
serving both legs. `node scripts/tasks.mjs` exits 0 after each commit.

## Notes

- Source: the 2026-09-05 architecture audit (chat deliverable; findings #1–#3).
- Skills: `tdd` for the behavior change in T-05 (red before green on the
  `search_text` continuation-page regression); commits carry the repo's
  `Co-authored-by: Copilot` trailer. Run checks through
  `node scripts/tasks.mjs`, never the npm scripts.
- Never hand-edit `package.json`/`server.json` versions (AGENTS.md). The Release
  workflow (`.github/workflows/release.yml`) does not touch `CHANGELOG.md`; a
  `## [Unreleased]` heading added here is renamed by hand at release.
- No new runtime dependencies.
- Charted decisions, confirmed by the user 2026-09-05 (no ticket; they bound
  every ticket below):
  - Landing order #3 → #2 → #1, smallest and safest first; encoded as
    `blocked_by` edges between the task tickets.
  - `search_text` continuation pages adopt first-page-only externalization
    (behavior change; CHANGELOG line + regression test).
  - One externalization trigger for `list`, `search_files`, `search_text`:
    **any incompleteness** — store the full (capped) set and return
    `resourceUri` on the first page when `items.length > pageSize` OR the hard
    cap truncated the set.
  - `FS_MAX_INLINE_MATCHES` is retired; `maxResults` is the only page/inline
    size for `search_text`. Semver class open in T-04.
  - Pure `jsonRpcError(code, message, id)` builder lives in
    `transport/shared.ts`; `sendJsonRpcError` in the moved `http-policy.ts`
    wraps it; `stdio.ts:311-334`'s two hand-built envelopes call it.
  - `RunResult.isError?: boolean` stays optional; `batch.ts` exports the one
    total-failure predicate over `BatchResult` and `PairBatchOutcome`.
  - CHANGELOG entries go under a new `## [Unreleased]` heading.

### Execution contract

- Scope: the three moves named in Destination, with their tests, CHANGELOG,
  README, and `cli-help.ts` text; nothing outside the files each task ticket
  lists.
- Completion: `node scripts/tasks.mjs` exits 0 on the commit that lands the
  task, and the commit is on `main`.
- Evidence: [`audit-seams.run.md`](audit-seams.run.md) — one entry per task
  ticket: command, exit code, pass/fail counts, commit hash.

## Decisions so far

- [Move http-policy.ts into transport/ and give both legs one JSON-RPC envelope builder](tickets/T-01-move-http-policy.md) — Delivered: `fee482cb`; `jsonRpcError<Id>()` in `transport/shared.ts`, HTTP wraps it, stdio's two envelopes call it; check exit 0, 273/0 ([run log](audit-seams.run.md)).
- [Hand total-batch-failure to batch.ts and drop the shape sniff in define.ts](tickets/T-02-iserror-handoff.md) — Delivered: `5cf5e0b1`; `RunResult.isError?`, `isTotalFailure()` in `batch.ts` over either count shape, seven tools set it, `isTotalBatchFailure` deleted; check exit 0, 273/0, pinned batch tests unmodified.
- [Which tests and call sites does the isError hand-off touch?](tickets/T-03-iserror-blast-radius.md) — seven tools (`create`, `move`, `read`, `edit`, `stat`, `delete`, `replace_text`); three build `summary` by hand, so the predicate takes a bare `{ total, failed }`; four total-failure and three partial-failure tests pin the rule and stay unmodified.
- [Which tests, docs, and schema texts encode the three externalization rules?](tickets/T-07-externalization-blast-radius.md) — one test flips (`tools.test.ts:790-794`, `TC-FUNC-063`); eight text strings rewrite, `instructions.ts:70-71` already matches; `FS_MAX_INLINE_MATCHES` has one read and two doc mentions; `find_files` has no `truncated` output field at all.

## Not yet specified

- `replace_files` (`src/tools/replace-in-files.ts`) has `maxResults` and its
  own `truncated` but no cursor. Whether the trigger helper T-05 lands is
  callable from a tool that does not paginate — and whether `replace_files`
  should call it — waits on the shape T-05 gives that helper.

## Out of scope

- Unifying `create`/`move` output schemas onto `summary` — ruled at charting:
  a published wire-contract break (trim-dead-surface plan.md:553); finding #2
  avoids the wire, so the schemas stay as they are.

## Superseded

<!-- closed tickets a later decision invalidated; link each ticket and its replacement -->
