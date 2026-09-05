---
kind: frontier-ticket
id: T-02
title: Hand total-batch-failure to batch.ts and drop the shape sniff in define.ts
map: M-01
status: open
type: task
priority: 20
blocked_by: [T-01, T-03]
claimed:
---

## Question

Deliver audit finding #2 as decided at charting, as one commit on `main`.

- Add `readonly isError?: boolean` to `RunResult` (`src/tools/define.ts:132-136`).
- `src/tools/batch.ts` exports the single total-failure predicate — every
  requested item failed, skipped items count as work done, zero items is not a
  failure — over its own `BatchResult` (`{ results, summary }`) and
  `PairBatchOutcome` (`{ results, skipped, failures }`).
- Each batch tool sets `isError` from that predicate on the result it already
  holds. Per
  [Which tests and call sites does the isError hand-off touch?](T-03-iserror-blast-radius.md):
  `create` (`create.ts:125-149`, `{files, failures}`), `move`/`copy`
  (`move.ts:303-317`, pair shape), `read` (`read.ts:516-524`, summary rebuilt
  by hand), `edit` (`edit.ts:579-586`), `stat` (`stat.ts:251-258`), `delete`
  (`delete-file.ts:402-406`, hand-built), `replace_text`
  (`replace-in-files.ts:499-525`, hand-built). Because three build `summary`
  themselves, the predicate accepts a bare `{ total, failed }` as well as
  `BatchResult` and `PairBatchOutcome`.
- `buildSuccessResponse` (`define.ts:252-266`) forwards `result.isError` and
  `isTotalBatchFailure` (`define.ts:219-244`) is deleted, so `define.ts` no
  longer knows `files` or `moves`.
- Wire output unchanged. These stay green unmodified: total failure
  `__tests__/tools.test.ts:148,181,479` and `__tests__/http-transport.test.ts:72`;
  partial failure `tools.test.ts:165,491,1142`.

Priority 20: second in the landing order; T-05 waits on its commit.

Completion per the map's execution contract: `node scripts/tasks.mjs` exits 0
on the landing commit; record in [`audit-seams.run.md`](../audit-seams.run.md).
Unblocks
[Own page replay and the externalization trigger in core/cursor.ts; retire FS_MAX_INLINE_MATCHES](T-05-cursor-owns-replay.md).
