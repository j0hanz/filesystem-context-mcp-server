---
kind: frontier-ticket
id: T-06
title: What does search_text.truncated mean once the inline cap is gone?
map: M-01
status: open
type: grilling
priority: 30
blocked_by: []
claimed:
---

## Question

`search_text` publishes `truncated` (`src/tools/search-content.ts:138-141`),
described as "True when the match list was cut due to maxResults or timeout".
Today it is set in two places with two meanings:

- `search-content.ts:278-280,305-307` — set when a page held more than
  `FS_MAX_INLINE_MATCHES` and the inline `matches` were sliced (the cap being
  retired under T-05);
- `search-content.ts:399` — copied from `result.summary.truncated`, the engine's
  hard-cap / timeout truncation of the whole result set.

With the inline cap gone, only the second source remains. Note, per
[Which tests, docs, and schema texts encode the three externalization rules?](T-07-externalization-blast-radius.md),
that `find_files` publishes **no** `truncated` field at all
(`search-files.ts:55-74`): incompleteness rides `resourceUri`, `nextCursor`,
and `stoppedReason`; the engine's `summary.truncated` stays internal. Choose
the field's meaning going forward:

- **A. Hard-cap or timeout only** — `truncated` reports the engine's stop
  state (`search-content.ts:402-404`); a set that merely spans several pages
  is not "truncated", it has `nextCursor`. Description at `:141` rewritten to
  say so.
- **B. Any incompleteness** — mirror the externalization trigger: `true`
  whenever `resourceUri` is present (multi-page OR hard-cap).
- **C. Drop the field** — match `find_files`: remove `truncated` from the
  output schema; `stoppedReason` already carries the engine's reason. Wire
  change: a removed optional field (CHANGELOG `### Removed`).

A is the recommendation: it keeps `truncated` a statement about the result
set, not about the page, and costs one schema line and one assignment in
T-05; C is cleaner but widens the wire change T-05 already carries.

Priority 30: gates only T-05.
