# Plan hunt: architecture-audit

Hunted [`architecture-audit.plan.md`](architecture-audit.plan.md) against the
repo at `2fb2de7c`, 2026-08-26.

**2 confirmed defects.** Both are in the plan's instructions, not in its
analysis; neither invalidates a step's goal. Six candidates were raised and put
to blind refuters — four were killed and are not reported here.

Route: back to `write-plan` to fix, then straight to `run-plan`. Nothing here
needs a re-hunt.

## Confirmed

### 1. Step 2's elided body carries an incomplete substitution list

**Where.** [`architecture-audit.plan.md`](architecture-audit.plan.md), Step 2,
inside the target-shape block:

```
        // ... body unchanged from prompts.ts:122-138, with `options.sections`
        // becoming `sections` and `options.instructions` becoming `instructions`
```

**Trigger.** A cold executor copies
[`prompts.ts:122-138`](../../../src/prompts.ts#L122-L138) and applies exactly
the two substitutions named.

**Impact.** The file does not compile. [`prompts.ts:136`](../../../src/prompts.ts#L136)
reads:

```ts
            description: GET_HELP.contract.description,
```

Step 2's target shape redefines `GET_HELP` as a flat
`const GET_HELP: PromptContract` with `name`, `title` and `description` and no
`contract` member. The word "unchanged" plus a closed list of two substitutions
tells the executor to keep `.contract`.

**Settles it.** The refuter's own check: search Step 2 for `contract`. Its only
mention is item 1's "Keep [`PromptContract`] — it is the parameter type of
[`wrapHandler`]", which is about the type, not the member access. Nothing else
in Step 2 flags the collapse.

**Severity.** Gated, not silent — `"noEmitOnError": true` at
[`tsconfig.json:37`](../../../tsconfig.json#L37) turns it into a build failure at
Step 2's own Verify. The executor loses a cycle, not correctness.

**Fix shape** (for the plan's author, not applied here): add
`` `GET_HELP.contract.` becoming `GET_HELP.` `` to the substitution list, or
inline all seventeen lines of the body so nothing is elided. The second is what
the plan's own self-contained rule asks for.

### 2. A Done check fails on the plan's own artifact

**Where.** [`architecture-audit.plan.md`](architecture-audit.plan.md), Done:

```
- [ ] `git status --porcelain` lists no file outside the
      [in-scope list](#scope)
```

**Trigger.** The executor runs the Done checklist in the tree where this plan
lives.

**Impact.** `git status --porcelain` prints `?? docs/`. The plan's In-scope list
names only `knip.json`, files under `src/`, and
[`__tests__/prompts.test.ts`](../../../__tests__/prompts.test.ts); the Out-of-scope
list exempts `dist/`, `node_modules/` and `logs/`, all of which are gitignored
and therefore invisible to porcelain anyway. `docs/` is the one untracked tree
nothing accounts for, so a clean run reports unclean.

**Settles it.** The refuter's own checks, run independently: `.git/index`
contains no `docs/` path while the same probe finds `package.json` and
`src/core/`, so the tree is genuinely untracked; `.gitignore` has no `docs` rule;
`.git/info/exclude` lists only `**/.claude/...`; `.git/config` sets no
`status.showUntrackedFiles`, so porcelain runs in its default mode and emits
`??` lines.

**Severity.** Cosmetic. Nothing is broken; the check as literally specified does
not pass.

**Fix shape.** Add the plan's own directory to the exempt list, or narrow the
check to `git status --porcelain -- src knip.json __tests__`.

> **Constraint on the fix.** A separate candidate — that the Done check
> `git grep -n "buildExecutionCtx\|PROMPT_ENTRIES\|attachFileWatcherForUri\|linkToInstructions"`
> can never return nothing — was killed on the ground that the plan file is
> untracked and `git grep` searches tracked files only. Resolving finding 2 by
> committing the plan would therefore make that check start matching the plan's
> own 26 occurrences. Fix finding 2 by exempting or narrowing, not by committing
> the plan mid-run.

## Coverage

Every step was worked against all five dead-step tells. What each check settled:

| Tell                           | Result                                                     |
| :----------------------------- | :--------------------------------------------------------- |
| Invented API                   | None. Every symbol opened at its definition.                |
| Path that won't resolve        | None. All 30 unique link targets exist.                     |
| Convention violated            | None. Registrar boundary and import rules hold.             |
| Step with no gate              | None. Every step names a Verify with expected output.       |
| Dependency or version assumed  | None. Every cited command was run at `2fb2de7c`.            |

**Steps re-verified by execution**, not by reading:

- Step 1's target shape was compiled: `npm run build` clean, `eslint` clean,
  `222/222` pass. The plan's claim that an object spread preserves
  `exactOptionalPropertyTypes` semantics holds. Tree reverted.
- Step 4's full edit set and Step 5's config were applied during plan authoring:
  build clean, lint clean, `222/222` pass, knip 0 findings, canary reports 1.
- `node scripts/tasks.mjs fix` was run to verify the Commands table entry — exit
  0, `222/222` pass. It runs the full suite, so Step 4's separate test run is
  redundant but not wrong.
- Bare `node scripts/tasks.mjs` resolves to `npm run check` at
  [`scripts/tasks.mjs:56`](../../../scripts/tasks.mjs#L56), confirming the Step 6
  gate includes knip.

**Anchors spot-checked** beyond the four the refuters covered:
[`transport/shared.ts:9,10,52-57,59,83`](../../../src/transport/shared.ts#L52-L62)
all match their excerpts verbatim;
[`resources.test.ts:282-426`](../../../__tests__/resources.test.ts#L282-L426) is
the registry-primitive block the plan says it is, closing at line 427.

**Step 3 remains the plan's only unexecuted step.** The hunt confirmed its cited
lines, symbols and import-cycle claim, but no trial move was made — the plan
already says so in its Notes, and the risk is unchanged by this hunt.

## Limits of this hunt

`[WARN]` The hunter authored the plan. Refutation was blind — six candidates
went to independent subagents that never saw the reasoning behind them, and four
came back killed, including one that surfaced an occurrence the hunter had
missed (`PROMPT_ENTRIES` in a test *title* at
[`prompts.test.ts:38`](../../../__tests__/prompts.test.ts#L38), already covered by
Step 2.4's rename). But **candidate generation** was not blind. A defect the
author could not see when writing the plan is a defect the author may not have
thought to raise as a candidate. A hunt by a session that did not write this plan
would cover a different set.
