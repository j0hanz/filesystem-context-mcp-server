# Plan hunt: overeng-residue

**Plan** [`overeng-residue.plan.md`](overeng-residue.plan.md), written against
`6cedcca9`. **Hunted** 2026-09-07 at `6cedcca9`, clean tree.

5 candidates raised, 5 refuted blind (one refuter each, none saw the hunter's
reasoning). **1 confirmed, 4 killed.**

## Confirmed

### 1. Step 13 keeps `PairFailureItem`, which its own Verify then fails on

**Where** step 13, [`overeng-residue.plan.md`](overeng-residue.plan.md) — the
"Keep in `batch.ts`" list and the import line two paragraphs below it.

The step says:

> Keep in `batch.ts`: `PairFailureItem` ([`:17-27`]) — it is the wire type
> `move.ts` still needs

and then:

> `move.ts`'s import line becomes
> `import { isTotalFailure, type PairFailureItem } from './batch.js';` — or drop
> `PairFailureItem` entirely if `MoveFailureItem` already covers every use, which
> it should.

Both halves are wrong, and they contradict each other.

**The justification is false.** `move.ts` does not import `PairFailureItem` today
and will not after the fold. Its only type import from `batch.ts` is
[`move.ts:22`](../../../src/tools/move.ts#L22):

```ts
import type { PairExecResult, PairPlanResult } from './batch.js';
```

`move.ts` already has its own wire type at
[`move.ts:51`](../../../src/tools/move.ts#L51) —
`type MoveFailureItem = z.infer<typeof MoveFailureItemSchema>;` — which step 13
itself uses for every replacement type.

**Every remaining reference dies in the same step.** All five occurrences of
`PairFailureItem` in the repo are in `batch.ts`, and four of them sit inside code
step 13 deletes or moves:

| Line | Context | Fate under step 13 |
| :--- | :--- | :--- |
| [`batch.ts:18`](../../../src/tools/batch.ts#L18) | the interface | kept (per the step) |
| [`batch.ts:123`](../../../src/tools/batch.ts#L123) | `PairPlanResult` | deleted |
| [`batch.ts:133`](../../../src/tools/batch.ts#L133) | `PairBatchOutcome` | deleted |
| [`batch.ts:164`](../../../src/tools/batch.ts#L164) | `pairFailure` return | moved to `move.ts` |
| [`batch.ts:206`](../../../src/tools/batch.ts#L206) | `runOverPairs` local | deleted |

`isTotalFailure`, the one kept function that could rescue it, is typed on
`readonly unknown[]` ([`batch.ts:152-155`](../../../src/tools/batch.ts#L152-L155))
and never names it.

**knip fails on the result.** `knip.json` sets only `entry`, `project`, and
`ignoreDependencies` — no `rules`, no `ignoreIssues`, no
`ignoreExportsUsedInFile` — so knip 6's default issue set applies, and
`types` (unused exported types) is **not** in its default exclusion list. Only a
reference from a *used exported function* rescues a type; `pairFailure`'s return
annotation is the sole thing rescuing `PairFailureItem` today, and step 13 moves
`pairFailure` out. `check:static` runs `knip` unflagged, so
`node scripts/tasks.mjs` — step 13's own Verify — exits non-zero.

The step's own fallback does not save it either: an imported-but-unused type in
`move.ts` trips `eslint . --max-warnings=0`.

**Fix**: move `PairFailureItem` from step 13's keep list to its delete list, and
strike the "or drop it entirely" alternative so the step reads as one
deterministic instruction. `move.ts` needs no type import from `batch.ts`
afterwards — only `isTotalFailure`.

## Killed

Reported for the record; no action.

| # | Candidate | Why it died |
| :--- | :--- | :--- |
| 2 | Step 9 leaves the `patch.ts` `resourceUri` narrowing unspecified | `def.output` is compile-time only — no tool publishes an `outputSchema` ([`define.ts:524-531`](../../../src/tools/define.ts#L524-L531), pinned by `tools.test.ts`'s TOOL-SURFACE-001), so every narrowing emits byte-identical `_meta`. `no-non-null-assertion` is already an error under `strictTypeChecked`, ruling out the one form that would differ. |
| 3 | Step 8 puts `diff` into `src/core/fmt.ts` | `src/core/` is already where dependency-carrying primitives live — `glob.ts` imports `ignore`, `search.ts` imports `@adguard/re2-wasm`, `schema.ts` imports `zod`. The repo's only import-boundary lint (`project/registrar-boundaries`) constrains the tool layer, not core. |
| 4 | Step 5 says "several already do" of the `ALL_TOOLS` import | A miscount (only `tools.test.ts` has it), but no executor action depends on it: the step lists the exact import line in all six files and makes editing that line mandatory. |
| 5 | Step 11 hedges on removing the `fsConstants` import | `tsconfig.json` pins `noUnusedLocals` with `noEmitOnError`, so a leftover import is a hard build failure, and the plan states the delegate-to-eslint convention twice elsewhere (steps 1 and 13). |

## Minors — prose accuracy, not dead steps

Two false statements in **Current state** that no step depends on. Fix them while
fixing finding 1, or leave them.

1. Step 8's rationale says "`diff.ts` and `move.ts` do" import `../core/fmt.js`.
   `move.ts` does; **`diff.ts` does not**. The `fmt.ts` consumers are `cli.ts`,
   `cli-help.ts`, `define.ts`, `delete-file.ts`, `move.ts`,
   `replace-in-files.ts`, `search-content.ts`, `search-files.ts`.
2. Step 5's "several already do" — one file, `tools.test.ts:23`.

## Verdict

One confirmed dead step. Steps 1–12 are clean.

## Resolution — 2026-09-07

Finding 1 fixed in the plan: `PairFailureItem` moved to step 13's delete list,
the "or drop it entirely" alternative struck, `move.ts`'s new import line fixed
to `import { isTotalFailure } from './batch.js';`, and `PairFailureItem` added to
the Done checklist's grep. Both Minors fixed. The step-13 defect marker is
removed. Plan cleared for run-plan.
