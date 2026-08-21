# Spec hunt: sep2577-input-required

Date: 2026-08-21. Adversarial pass over [`sep2577-input-required.spec.md`](sep2577-input-required.spec.md) before write-plan.

## Candidates and refuter verdicts

Three candidate gaps raised; each sent to one blind refuter (`general-purpose`, read-only).

| #   | Candidate                                                                                                                                                            | Requirement   | Refuter verdict | Disposition                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Mixed-batch semantics unspecified — a tools/call with some items needing confirmation and some not; unclear whether non-pending items mutate in round 1 or on retry. | R2 / R7 / R13 | **confirmed**   | Fixed via [`spec-delta`](sep2577-input-required.spec-delta.md) (added R14 atomic batch; modified R13 wording).                            |
| G2  | R5 (missing/cancelled → per-item decline) vs R12 (malformed → reject whole) boundary.                                                                                | R5 / R12      | killed          | Dropped. R12 "do not parse as responses" = whole reject; A2 + R5 handle per-item decline/cancel/missing.                                  |
| G3  | R7 access-grant scoped to "a tool" — does it apply to resources/read?                                                                                                | R7            | killed          | Dropped. Out of scope: "Prompt and resource elicitation — no current usage; nothing to migrate." Access-grant surface is tools/call only. |

## Result

One confirmed gap (G1), folded back as a spec delta adding R14 (atomic batch) and
adjusting R13. Two killed. No gaps remain in the spec + delta set.

Re-hunt of the delta: not run — R14 is a single, well-formed requirement (one
obligation, a falsifier, three Given/When/Then) with no undefined terms beyond
those the spec already defines ("non-pending", "accepted", "cancelled"). The
atomic-batch decision is unambiguous. Forwarding to write-plan.

## Forward

To [`write-plan`](../../../) next, against the spec + delta.
