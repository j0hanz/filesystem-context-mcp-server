# Verification: SEP-2577 input_required migration

Against [`sep2577-input-required.spec.md`](sep2577-input-required.spec.md), working
tree on branch `sep2577-input-required` (base `cf4f255`), 2026-08-21.

| ID  | Verdict | Observation                                                        | Evidence                                                                                                                                                          |
| --- | ------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | met     | destructive call returns `input_required`, FS untouched in round 1 | `delete-file.test.ts:122-124`; `move.test.ts:200`; `elicitation-era.test.ts:112,146`                                                                              |
| R2  | unmet   | no integration call fires two pending items                        | only `buildInputRequired` mechanism tested (`input-required.test.ts:51`); R14 batches carry one pending item each (`delete-file.test.ts:218`, `move.test.ts:244`) |
| R3  | met     | accepted retry performs the operation                              | `delete-file.test.ts:114`; `move.test.ts:190`; `access-grant.test.ts:135`                                                                                         |
| R4  | met     | declined retry leaves FS, reports CANCELLED                        | `delete-file.test.ts:139`; `move.test.ts:217`                                                                                                                     |
| R5  | met     | cancel + missing response → CANCELLED, not performed               | `delete-file.test.ts:165`                                                                                                                                         |
| R6  | met     | no retry → FS unchanged (fail-closed)                              | `delete-file.test.ts:192`; `elicitation-era.test.ts:112,146`                                                                                                      |
| R7  | met     | out-of-root read → `input_required`, reads nothing                 | `access-grant.test.ts:110`                                                                                                                                        |
| R8  | met     | accepted grant proceeds; second call does not re-prompt            | `access-grant.test.ts:135`                                                                                                                                        |
| R9  | met     | state↔paths mismatch rejected; grant for X cannot authorize Y      | `delete-file.test.ts:257`; `access-grant.test.ts:166`                                                                                                             |
| R10 | met     | tampered requestState rejected                                     | `input-required.test.ts:37`                                                                                                                                       |
| R11 | met     | no `elicitation/create` push from destructive flows                | `elicitation-era.test.ts:112,146` — clean `input_required` on an `elicitInput`-less context (a push would crash)                                                  |
| R12 | unmet   | malformed `input responses` never sent to a retry                  | no test fires the trigger; "malformed" hits elsewhere are schema/cursor/JSON-RPC-body/Origin                                                                      |
| R13 | met     | no-confirmation call proceeds without round-trip                   | `delete-file.test.ts:240`; `move.test.ts:293`                                                                                                                     |
| R14 | met     | mixed batch: nothing in round 1, all accepted/non-pending on retry | `delete-file.test.ts:208`; `move.test.ts:244`                                                                                                                     |

## Unmet

- **R2** — A `tools/call` carrying two pending items (e.g. two non-empty dirs to
  delete, or two overwriting moves) is never driven through a handler. The
  `buildInputRequired` unit test (`input-required.test.ts:51`) observes the
  result _shape_ carries multiple requests, but no integration test observes a
  handler producing one `input_required` asking about both pending items. Code
  appears correct (the plan loop collects all pending into `pendingSorted` and
  builds one `confirm` per pending), but the falsifier — "a result that asks
  about only one of the pending items" — is untriggered. **Handoff:
  [write-plan](../write-plan/SKILL.md)** follow-up test naming R2 (a
  two-non-empty-dir delete and a two-overwrite move, asserting one
  `input_required` with both `confirm_0`/`confirm_1`).

- **R12** — An `If … then …` (unwanted-behavior) requirement whose trigger is
  never fired: no test retries a destructive call with malformed `input
responses` (e.g. `responses` of the wrong type, or a `confirm_0` entry that
  does not parse as a response). `readAcceptedConfirm` returns false for
  non-accepted shapes, so the code likely rejects without performing — but an
  error path nobody triggered is **unverified**. **Handoff:
  [write-plan](../write-plan/SKILL.md)** follow-up test naming R12 (send
  malformed `inputResponses` to a delete/move retry; assert no mutation and that
  the retry is rejected/reported cancelled). If the test reveals the code
  reports `CANCELLED` where the spec says "returns an error," that becomes a
  [spec delta](../write-specs/SKILL.md#spec-delta) on R12.

## Folded

- **R14** (ADDED by [`spec-delta`](sep2577-input-required.spec-delta.md)) — met
  via `delete-file.test.ts:208` and `move.test.ts:244`. Folded into the
  canonical spec under Requirements, ID intact.
- **R13** (MODIFIED by the delta to "perform every item without an
  `input_required` round-trip") — met via `delete-file.test.ts:240` and
  `move.test.ts:293`. Folded into the canonical spec; the single-file Given
  still satisfies the modified wording.

## Reviewers

Correctness/security: [bug-hunt](../bug-hunt/SKILL.md) — run, one Confirmed
Minor (GRANT-1, [`hunt.md`](sep2577-input-required.hunt.md)). Structure:
[qc](../qc/SKILL.md) — run, REQUEST_CHANGES (3 blocking: R9 round-trip helper
triplicated, test stub harness copy-pasted across 5 files, `precheckGrant`
outside the handler error envelope). Behavior: this verdict.
