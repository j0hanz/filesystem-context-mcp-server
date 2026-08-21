# Spec: SEP-2577 input_required migration

A filesystem MCP server that moves its destructive-confirmation flows (recursive
delete, move overwrite, out-of-root access grant) from the deprecated push-style
`elicitInput` to the `input_required` multi-round-trip result, so they work on the
2026-07-28 protocol era.

## Why

The server's destructive confirmations use `elicitInput`, a push-style
server→client request deprecated by SEP-2577. It throws locally on the 2026-07-28
protocol era (the push model is replaced by `input_required` results); the server
catches that and degrades — recursive delete proceeds unprompted, move fails
closed, access-grant silently denies. That degrades safe-by-default behavior and
blocks the server from adopting the modern era. Migrating to `input_required`
makes confirmations correct on the modern era and removes the deprecation surface.
Intent: preserve the _meaning_ of each confirmation (a human must approve a
destructive act) while changing only the wire mechanism.

See the decision record: [`docs/mcp-decisions.md`](../../../docs/mcp-decisions.md)
(2026-08-21) — modern-only era, `input_required` result type, one-shot staging.

## Users and stories

- **P1** — As a client user, I want a destructive operation to pause for my
  confirmation and only proceed after I accept, so that nothing destructive happens
  without my explicit yes. (R1, R3, R4, R5, R6, R13)
- **P2** — As a client user batching several destructive items in one call, I want
  a single confirmation round-trip covering all of them, so that I am not ping-ponged
  once per item. (R2)
- **P3** — As a user pointed at a path outside the granted roots, I want the server
  to ask me to grant access to that path and then remember the grant for the
  session, so that I do not re-confirm every call. (R7, R8)
- **P4** — As the operator, I want a confirmation bound to the exact operation it
  approves, so that a `yes` for one path cannot be replayed against another. (R9, R10)
- **P5** — As the SDK maintainer, I want the deprecated `elicitInput` push gone from
  destructive flows, so that the server is era-clean. (R11, R12)

## Requirements

Terms: a `destructive operation` is a recursive delete of a non-empty directory, a
move that overwrites an existing destination, or any operation on a path outside
the granted roots. An `input_required` result is the multi-round-trip result the
server returns to ask the client for input; the client retries the same request
carrying `input responses`.

- **R1** When a `tools/call` would perform a destructive operation, the server
  shall return an `input_required` result and shall not perform that operation
  until the client retries the same request with `input responses`.
  - Falsified by: a destructive operation mutating the filesystem in the same
    round as the prompt, or being performed before a retry.
  - Given a recursive delete of a non-empty directory, When `tools/call` is
    invoked, Then the first response is `input_required` and the directory still
    exists.

- **R2** When a single `tools/call` requires confirmation for more than one
  item, the server shall return one `input_required` result requesting
  confirmation for every pending item in that call.
  - Falsified by: a call with two pending items requiring two round-trips, or a
    result that asks about only one of the pending items.
  - Given a delete of two non-empty directories, When `tools/call` is invoked,
    Then one `input_required` result requests confirmation for both directories.

- **R3** When the client retries with an accepted confirmation for an item, the
  server shall perform that item's operation.
  - Falsified by: an accepted confirmation that does not produce the operation.
  - Given an `input_required` for a recursive delete, When the client retries with
    the confirmation accepted, Then the directory is deleted.

- **R4** When the client retries declining an item, the server shall not perform
  that item's operation and shall report it as cancelled.
  - Falsified by: a declined item being performed, or a declined item reported as
    anything but cancelled.
  - Given an `input_required` for a recursive delete, When the client retries with
    the confirmation declined, Then the directory still exists and the result
    reports that path as cancelled.

- **R5** When the client retries with a cancelled or missing response for an item,
  the server shall treat that item as declined.
  - Falsified by: a cancelled or missing response performing the item's operation.
  - Given an `input_required` for a move overwrite, When the client retries with
    the response cancelled, Then the destination is not overwritten and the item
    is reported as cancelled.

- **R6** Where the client cannot fulfill `input_required` at all and never
  retries, the server shall leave the filesystem unchanged for the pending
  destructive items.
  - Falsified by: a destructive operation being performed without an accepted
    confirmation.
  - Given an `input_required` for a recursive delete, When the client never
    retries, Then the directory still exists.
  - Note: this changes current behavior for recursive delete, which today proceeds
    unprompted when `elicitInput` is unavailable. See open question Q1.

- **R7** When a tool would operate on a path outside all granted roots, the
  server shall return an `input_required` result requesting an access grant for
  that path, and shall not perform any filesystem operation on that path before
  the grant.
  - Falsified by: an out-of-root operation being performed in the same round as
    the prompt, or the prompt being omitted.
  - Given a read of a path outside the roots, When `tools/call` is invoked, Then
    the response is `input_required` requesting a grant and the path is not read.

- **R8** When the client retries with an accepted access grant for a path, the
  server shall apply that grant for the remainder of the session and proceed with
  the operation.
  - Falsified by: a granted path being asked to re-grant on a later call in the
    same session, or the operation not proceeding after a grant.
  - Given an `input_required` access grant for path P, When the client retries
    with the grant accepted, Then the operation proceeds; and Given a later
    `tools/call` on P in the same session, When invoked, Then no grant is
    requested.

- **R9** The server shall bind each confirmation to the specific operation it
  approves — the operation kind and the set of target paths — through
  integrity-protected request state, and shall reject any retry whose state fails
  verification or whose target paths do not match the retried request's
  parameters.
  - Falsified by: a confirmation accepted for path X being used to perform the
    same operation on path Y when the retried parameters name Y.
  - Given an `input_required` for deleting path X, When the client retries with
    the confirmation accepted but the request parameters changed to path Y, Then
    path Y is not deleted.

- **R10** The request state shall be opaque to the client and integrity-protected;
  tampering with it shall cause verification to fail.
  - Falsified by: a client altering the request state and the server accepting it.
  - Given an `input_required` carrying state S, When the client retries with a
    modified state S', Then the server rejects the retry without performing the
    operation.

- **R11** The server shall not send a deprecated `elicitation/create` push request
  for destructive confirmations.
  - Falsified by: an `elicitation/create` request being emitted by a destructive
    confirmation flow.
  - Given a recursive delete, When `tools/call` is invoked, Then no
    `elicitation/create` request is sent to the client.

- **R12** If the client retries with malformed `input responses`, the server shall
  not perform the operation, and shall report the affected item's outcome as
  cancelled (or return an error), never as a success.
  - Falsified by: malformed responses causing the operation to proceed, or being
    reported as a success.
  - Given an `input_required`, When the client retries with responses that do not
    parse as responses, Then the server does not perform the operation, and
    reports the affected item as cancelled (or returns an error).

- **R13** When no item in a `tools/call` requires confirmation, the server shall
  perform every item without an `input_required` round-trip.
  - Falsified by: a non-destructive call returning `input_required`.
  - Given a delete of a single file, When `tools/call` is invoked, Then the file
    is deleted with no `input_required` result.

- **R14** While at least one item in a `tools/call` requires confirmation, the
  server shall perform no item in that call until the client retries with `input
responses`; on retry, the server shall perform every accepted or non-pending
  item and report every declined, cancelled, or missing item as cancelled.
  - Falsified by: a non-pending item being performed in the same round as the
    prompt, or a declined item being performed on retry, or an accepted item not
    being performed on retry.
  - Given a delete of `[fileA, nonEmptyDirB]` where only `nonEmptyDirB` needs
    confirmation, When `tools/call` is invoked, Then neither `fileA` nor
    `nonEmptyDirB` is removed and the response is `input_required`.
  - Given that `input_required`, When the client retries accepting `nonEmptyDirB`,
    Then both `fileA` and `nonEmptyDirB` are removed.
  - Given that `input_required`, When the client retries declining `nonEmptyDirB`,
    Then `fileA` is not removed and `nonEmptyDirB` is reported cancelled.

## Constraints

- Era target is modern-only (`legacy: reject`), per the decision record
  [`docs/mcp-decisions.md`](../../../docs/mcp-decisions.md) (2026-08-21, decision
  13). This spec covers the destructive-confirmation half of that; the era-reject
  pin itself is out of scope here (see Out of scope).
- Input schemas use `zod ^4.2.0` via `zod/v4`; runtime is Node ≥24, ESM-first
  (decision record, decisions 5 and 14).
- Existing error vocabulary is preserved: a cancelled item is reported with the
  existing `CANCELLED` code — see current usage in
  [`delete-file.ts:195`](../../../src/tools/delete-file.ts#L195) and
  [`move.ts:89`](../../../src/tools/move.ts#L89).
- The SDK requires `requestState` that influences authorization or business logic
  to be integrity-protected by the server — quoted from
  [`createMcpHandler-CLhGwQTn.d.mts:2134`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L2134).
- `input_required` is a return value, not an imperative call; only `tools/call`,
  `prompts/get`, and `resources/read` handlers may return it —
  [`createMcpHandler-CLhGwQTn.d.mts:747`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L747).

## Out of scope

- **Roots synchronizer rearchitecture** — `listRoots()` runs in notification
  handlers with no `mcpReq`, so it cannot return `input_required`; the modern
  lazy in-handler roots fetch is a separate rearchitecture and gets its own spec.
- **Era-reject pin** (`supportedProtocolVersions` restricted to the 2026 era) —
  only safe once roots no longer needs the 2025 push path; belongs with the roots
  spec.
- **`getClientCapabilities` removal in the roots path** — moves with the roots
  spec; the capability check that gates destructive confirmation is in scope here.
- **Dual-era support** — the decision record chose modern-only; the 2025-era
  fallback paths are removed, not maintained.
- **Prompt and resource elicitation** — no current usage; nothing to migrate.

## Success criteria

1. A recursive delete of a non-empty directory never mutates the filesystem unless
   the client retries with an accepted confirmation — observable by stat before
   and after.
2. A single `tools/call` carrying several destructive items confirms in exactly
   one `input_required` round-trip — observable in the wire transcript.
3. An out-of-root access grant, once accepted, is honored for the rest of the
   session without a second prompt — observable by a second call on the same path.
4. No `elicitation/create` request is emitted by any destructive flow — observable
   in the wire transcript.

## Assumptions and open questions

Assumptions (defaults chosen where input was silent; A1 and A2 confirmed by the
operator on 2026-08-21):

- **A1** A destructive operation is fail-closed without an accepted confirmation:
  if the client never retries, the operation does not happen. This changes current
  recursive-delete behavior, which proceeds unprompted when elicitation is
  unavailable. Confirmed acceptable.
- **A2** Batch confirmation is modeled as one `input_required` result carrying one
  embedded elicitation request per pending item, keyed by item. The client returns
  one response per key. Decline/cancel/missing per item is handled per-item.
- **A3** Request state is an HMAC-bound token encoding the operation kind and the
  sorted target path set; verification rejects mismatched or tampered state. No
  external store — state is self-contained.
- **A4** An access grant applies per-granted-path for the session lifetime, held
  in the existing `PathGuard` allowed-directory state.

Open questions: none remaining.
