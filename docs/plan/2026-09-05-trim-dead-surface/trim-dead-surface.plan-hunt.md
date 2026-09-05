# Plan hunt: trim-dead-surface

Adversarial pass over [`trim-dead-surface.plan.md`](trim-dead-surface.plan.md),
2026-09-05, against commit `0223af11` with a clean working tree.

**Result: 1 confirmed defect, 2 candidates killed.** The plan is not executable
as written — one Verify command does not do what the plan says it does. Every
other step, path, symbol, and count checked out.

## Confirmed

### F1 — the "one test file" command runs the whole suite

**Where**: [`trim-dead-surface.plan.md`](trim-dead-surface.plan.md) — the
`| One test file |` row of `## Commands`, the step 3 Verify line, and the step 5
Verify line.

**Claim in the plan**: `node scripts/tasks.mjs test __tests__/progress.test.ts`
runs that one file.

**What it actually does**: runs all 275 tests.
[`scripts/tasks.mjs:70-77`](../../../scripts/tasks.mjs#L70-L77) appends its own
glob unconditionally after the caller's arguments:

```js
    case 'test':
      return run(process.execPath, [
        '--test',
        '--import',
        'tsx',
        ...commandArgs,
        '__tests__/**/*.test.ts',
      ]);
```

So the invocation becomes
`node --test --import tsx __tests__/progress.test.ts __tests__/**/*.test.ts`,
and Node's runner unions the file arguments.

**Observed**: the plan's exact command prints `tests 275 / suites 65`, identical
to the bare `node scripts/tasks.mjs test`. Independently reproduced by the
refuter.

**Impact**: the step-3 and step-5 gates do not isolate their step. A failure
anywhere in the suite is indistinguishable from a failure the step caused, which
is exactly the judgement a gated plan exists to spare a cold executor.

**Fix applied** (author, post-hunt): the task runner's supported narrowing is
`--test-name-pattern`, documented in its own help at
[`tasks.mjs:20`](../../../scripts/tasks.mjs#L20). Both Verify lines now use it,
with totals observed on the unmodified tree:

| Command | Observed |
| :--- | :--- |
| `node scripts/tasks.mjs test --test-name-pattern="McpProgressSink"` | `tests 27, suites 1, pass 27, fail 0`, 2.5s |
| `node scripts/tasks.mjs test --test-name-pattern="get-help"` | `tests 26, suites 3, pass 26, fail 0`, 2.5s |

## Killed

Two candidates went to blind refuters and did not survive. Recorded only so a
re-hunt does not re-raise them.

- **Done-checklist diff range** — `git diff --stat 0223af11..HEAD` was suspected
  of measuring nothing for an executor who never commits. Killed: the plan's own
  `## Notes` already directs "commit each step separately", so `HEAD` has
  advanced by the time the checklist runs.
- **`suites 62` arithmetic** — the post-change suite count was suspected of being
  unverified, given one of the three deleted `describe` blocks is nested. Killed
  empirically: a flat repo-wide count of `describe(` in `__tests__/*.test.ts`
  returns 65, exactly matching node:test's reported `suites 65`, so nesting does
  not affect the tally and `65 - 3 = 62` holds.

## Checked and clean

Every other claim the plan makes, settled against the repo:

| Claim | Check | Result |
| :--- | :--- | :--- |
| All QA paths are tracked, so `git rm` works | `git ls-files scripts/` | all 8 listed |
| `qa` is the last entry in the scripts block | [`package.json:40-45`](../../../package.json#L40-L45) | yes; `tasks` above it carries the comma |
| Fleet describe is self-contained | [`http-server.test.ts:251-262`](../../../__tests__/http-server.test.ts#L251-L262) | own `tmpDir`, `servers`, `STATE_KEY`, `beforeEach` |
| Deleted test counts sum to 10 | `grep -c` per block | 5 + 4 + 1 → `pass 265` |
| `bootHttpTest`'s 3rd parameter has one caller | repo grep | only [`subscriptions-listen.test.ts:363`](../../../__tests__/subscriptions-listen.test.ts#L363) |
| `Phase` is used outside `fmt.ts` | repo grep | no — safe to narrow |
| `ProgressEvent` is used outside `progress.ts` | repo grep | no |
| A test asserts the prompt topic rejections | [`prompts.test.ts`](../../../__tests__/prompts.test.ts) | no — only known/unknown lookup, which is the `Object.hasOwn` path |
| A test asserts the CLI directory-error text | `grep -rn __tests__/` | no matches |
| `isRecord` has a consumer beyond `cli.ts:58` | repo grep | no — the plan is right to delete the export |
| Two steps edit the same file | scope cross-check | none, so no cited line number shifts under an earlier step |
| Cited line ranges resolve | opened each | 5 were off by 1-2 and were corrected before this hunt |

## Verdict

F1 is fixed in place and the plan is cleared for
[run-plan](../../../../../Users/PC/.claude/plugins/cache/j0hanz-marketplace/workbench/0.20.0/skills/run-plan/SKILL.md).
No re-hunt needed: the fix changes two Verify commands and one Commands row,
touching no step's content.
