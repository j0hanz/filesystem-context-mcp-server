---
kind: frontier-ticket
id: T-04
title: Does retiring FS_MAX_INLINE_MATCHES ship as a MAJOR removal or a MINOR accept-and-ignore?
map: M-01
status: open
type: grilling
priority: 30
blocked_by: []
claimed:
---

## Question

The user ruled at charting that `FS_MAX_INLINE_MATCHES` is retired
(`src/tools/search-content.ts:42`, documented at `src/cli-help.ts:121` and
`README.md:405`). Two ways to ship that:

- **MAJOR — hard removal.** The env var is unread; CHANGELOG `### Removed`; the
  next release is a major bump under semver, since a documented configuration
  input disappears.
- **MINOR — accept and ignore.** The var is still read; when set, the server
  logs one `warning` via `Logger` at startup that it is ignored and will be
  removed in the next major; CHANGELOG `### Deprecated`; no bump-class change.

Which one, and — if MINOR — does the warning name `maxResults` as the
replacement? This fixes the CHANGELOG section, the `cli-help.ts` entry (delete
vs mark deprecated), and one branch of T-05's implementation.

Priority 30: gates only T-05, the last task in the landing order.
