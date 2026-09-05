---
kind: frontier-ticket
id: T-01
title: Move http-policy.ts into transport/ and give both legs one JSON-RPC envelope builder
map: M-01
status: closed
type: task
priority: 10
blocked_by: []
claimed:
---

## Question

Deliver audit finding #3 as decided at charting, as one commit on `main`.

- `git mv src/http-policy.ts src/transport/http-policy.ts`; repoint
  `src/transport/http.ts:47` and `__tests__/http-policy.test.ts:22`.
- Rewrite the stale header at `http-policy.ts:22-27` — it claims the file lives
  at root "because `transport.ts` already imports this module"; `transport.ts`
  is a four-line facade and does not.
- Add a pure `jsonRpcError(code: number, message: string, id: string | number | null = null)`
  builder to `src/transport/shared.ts` returning the `{ jsonrpc, id, error }`
  literal. `sendJsonRpcError` in the moved `http-policy.ts` builds its body
  through it. Replace the two hand-built envelopes in
  `src/transport/stdio.ts:311-334` (`InvalidParams` on a failed listen
  preparation, `InternalError` in the catch) with the builder.
- No behavior change on either wire; existing `http-policy.test.ts`,
  `http-server.test.ts`, and `stdio.test.ts` cases are the net.

Priority 10: first in the landing order the user chose (#3 → #2 → #1); the
smallest move, and T-02 waits on its commit.

Completion per the map's execution contract: `node scripts/tasks.mjs` exits 0
on the landing commit; record command, exit code, counts, and hash in
[`audit-seams.run.md`](../audit-seams.run.md). Unblocks
[Hand total-batch-failure to batch.ts and drop the shape sniff in define.ts](T-02-iserror-handoff.md).

## Resolution

Classification: **Delivered** under the map's execution contract.

- `src/http-policy.ts` → `src/transport/http-policy.ts` (`git mv`); imports
  repointed in `src/transport/http.ts` and `__tests__/http-policy.test.ts`;
  the stale "transport.ts already imports this module" header replaced with
  one that names `shared.ts` as the envelope owner.
- `jsonRpcError<Id>(code, message, id)` added to `src/transport/shared.ts`.
  Generic on the id so stdio's narrowed `string | number` satisfies the SDK's
  `JSONRPCMessage` (which has no `null` id) while HTTP passes `null`; no
  default, since `sendJsonRpcError` already owns HTTP's `null` default.
- `sendJsonRpcError` builds its body through it; `stdio.ts`'s two hand-built
  envelopes (`InvalidParams` on failed listen preparation, `InternalError` in
  the catch) call it. `JSONRPC_VERSION` is now imported only in `shared.ts`.
- Net: 5 files, +38 / −28 including the rewritten header; stdio −8.

Completion check: `node scripts/tasks.mjs` → exit 0, 273 pass / 0 fail, static
gate clean. Evidence: [`audit-seams.run.md`](../audit-seams.run.md), entry
T-01. Commit `fee482cb` on `main`.

Material uncertainty: none. One deviation from the Question as written: the
builder takes `id` as a required generic parameter rather than defaulting to
`null` — the type-checker forced it, and it is the tighter contract.