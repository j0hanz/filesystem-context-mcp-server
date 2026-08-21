amends [`sep2577-input-required.spec.md`](sep2577-input-required.spec.md)

# Spec delta: mixed-batch atomicity

spec-hunt confirmed one gap: a `tools/call` whose items split — some require
confirmation, some do not — has no specified behavior. R1 holds back only the
destructive item; R2 acknowledges non-pending items but specifies only the pending
ones; R13 excludes the mixed case by its "no item requires confirmation"
precondition. A cold executor must guess whether non-pending items mutate in round
1 or only on the retry.

Resolution chosen: **atomic batch**. If any item in a `tools/call` requires
confirmation, the server performs no item — pending or not — until the client
retries. Partial batches (some items applied before a possible decline of others)
are a footgun and are disallowed. On retry, accepted and non-pending items proceed;
declined/cancelled/missing items are reported cancelled.

## ADDED

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

## MODIFIED

- **R13** was: "When no item in a `tools/call` requires confirmation, the server
  shall perform the operation without an `input_required` round-trip." — now: "When
  no item in a `tools/call` requires confirmation, the server shall perform every
  item without an `input_required` round-trip." Reason: align with R14's per-item
  wording and the batch model; the precondition (no item requires confirmation) is
  unchanged, so the mixed case is still owned by R14.

## REMOVED

none.

# Spec delta: R12 malformed-response outcome is CANCELLED, not an error

The R12 test (`delete-file.test.ts`, "R12: a malformed retry response does not
perform the delete") retried an `input_required` delete with
`{ confirm_0: { action: 'accept', content: {} } }` — accept with no `confirm`
field. Observed, empirically confirmed against the built `dist`:

```json
{"content":[{"type":"text","text":"delete: 1 failure"}],
 "structuredContent":{"ok":false,"failures":[{"path":"...","error":
   {"code":"CANCELLED","message":"Delete cancelled: confirmation was declined or missing", ...}}]}}
```

No `isError`, no `-32602`, no thrown `FsError`. `readAcceptedConfirm`
(`src/tools/input-required.ts`) treats "accept with missing `confirm`" the same
as "declined" — a deliberate design choice per its own doc comment ("every
other outcome … returns `false`, which the caller reports as `CANCELLED`"),
consistent across R4/R5/R12. The dir is not deleted — the operation does not
proceed, satisfying R12's substance — but the client-visible shape is a
successful-tool-call-with-per-item-CANCELLED-failure, not "the server returns
an error."

## MODIFIED

- **R12** was: "the server shall reject the request without performing the
  operation … Then the server returns an error and does not perform the
  operation." — proposed: "the server shall not perform the operation … Then
  the server does not perform the operation, and reports the affected item's
  outcome as cancelled (or returns an error), never as a success." Reason:
  align the requirement with the one `readAcceptedConfirm` codepath that
  already handles every non-accepted/malformed shape (decline, cancel, missing
  key, accept-without-confirm) — R12 is not a distinct error path, it is the
  same CANCELLED path R4/R5 already specify, triggered by a malformed instead
  of a declined response.

**Resolved 2026-08-21**: operator chose to amend R12's wording to match the
CANCELLED behavior. Applied to
[`sep2577-input-required.spec.md#requirements`](sep2577-input-required.spec.md#requirements)
verbatim as proposed above.
