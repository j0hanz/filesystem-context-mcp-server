# Run: architecture-audit

Executed [`architecture-audit.plan.md`](architecture-audit.plan.md) at
`2fb2de7c`, 2026-08-26. Drift check clean before Step 1.

**All six steps landed. No STOP condition fired. No step deviated from the
plan.** 222/222 tests at every gate; `node scripts/tasks.mjs` exits 0.

Net: **20 files, +286 / −331.**

## Steps

| #   | Step                          | Gate result                          |
| :-- | :---------------------------- | :----------------------------------- |
| 1   | `buildExecutionCtx` → spread  | `--quick` 0, `222/222`               |
| 2   | Inline the single prompt      | `--quick` 0, `222/222`               |
| 3   | Ladder → `registry.acquire()` | `--quick` 0, `222/222`, edge gone    |
| 4   | Narrow 27 module surfaces     | `fix` 0, `222/222`                   |
| 5   | Fix the knip entry set        | knip 0 findings; canary reports 1    |
| 6   | Full check                    | `node scripts/tasks.mjs` 0           |

## Done checklist

- [x] `node scripts/tasks.mjs --quick` exits 0
- [x] `node scripts/tasks.mjs test` exits 0 — `tests 222`, `pass 222`, `fail 0`
- [x] `npx knip --no-progress` prints no `Unused exports` section
- [x] Canary reports exactly one unused export, revert restores the file
- [x] `git grep -n "from '../resources.js'" -- src/transport` returns nothing
- [x] `git grep` for the four deleted symbols returns nothing
- [x] `git status --porcelain -- src knip.json __tests__` lists 20 files, all
      in scope — an exact match to the plan's In-scope list, no more, no less

## Deviations

One, in Step 5's verification only.

The plan's canary block reverts with `git checkout -- src/core/util.ts`. Step 4
un-exports `parseIntSetting` in that same file, so with the work uncommitted
that revert discards a required edit. The plan-hunt refuter established this is
self-detecting — `parseIntSetting` is one of the 27, so the next knip run names
it — but detection is not avoidance. The canary was run with a file-copy revert
instead:

```
cp src/core/util.ts /tmp/util.bak
printf '\nexport const KNIP_CANARY = 1;\n' >> src/core/util.ts
npx knip --no-progress          # Unused exports (1)  KNIP_CANARY  src/core/util.ts:111:14
cp /tmp/util.bak src/core/util.ts && rm /tmp/util.bak
```

Post-revert state confirmed: `src/core/util.ts:38` reads
`function parseIntSetting(` (still un-exported), and `KNIP_CANARY` occurs zero
times. Same evidence, no hazard.

## Two plan defects fixed before running

Both were confirmed by [`architecture-audit.plan-hunt.md`](architecture-audit.plan-hunt.md)
and repaired in the plan, not worked around during the run:

1. **Step 2's elided handler body** listed two substitutions where the body
   needs three — [`prompts.ts:136`](../../../src/prompts.ts) read
   `GET_HELP.contract.description` against a `GET_HELP` that no longer has a
   `contract` member. The step now inlines all seventeen lines verbatim.
2. **The `git status` Done check** was unsatisfiable: it flagged the plan's own
   untracked `docs/` tree. Narrowed to
   `git status --porcelain -- src knip.json __tests__`, with a note against
   resolving it by committing the plan — that would make the sibling `git grep`
   check match the plan's own prose.

## What actually changed

**Step 3 held its blast radius.** The plan predicted
[`transport/http.ts`](../../../src/transport/http.ts) and
[`transport/stdio.ts`](../../../src/transport/stdio.ts) would need no edit
because they touch only `hasWatcher`, `size`, `release` and `destroy`.
`git diff --stat` on both is empty. The transport-to-registrar import at
`transport/shared.ts:10` is gone, and `watcherFailureMessage` now names
`Exclude<WatcherAttachResult, { ok: true }>` instead of deriving the type
through `Exclude<Awaited<ReturnType<typeof attachFileWatcherForUri>>, …>`.

**The registry surface grew by one, as scoped.** It now reads:

```
hasWatcher, isAtCap, size, isStale, startSubscribe, cancelSubscribe,
addCallback, retain, release, acquire, attach, destroy
```

Seven members were hoisted to `const` above the `return` so `acquire` can
sequence them from inside the closure; every signature and the shape of the
returned object are unchanged. Privatizing the seven remains deferred — it needs
[`__tests__/resources.test.ts:282-426`](../../../__tests__/resources.test.ts)
rewritten against `acquire` first.

**One formatting fixup.** Prettier flagged
`src/core/watcher-registry.ts` after the Step 3 move (`--quick` caught it);
`prettier --write` on that file resolved it. Step 4's `node scripts/tasks.mjs fix`
found nothing further to reformat anywhere in the repo.

## Still open

Unchanged from the plan's Notes — none of these were in scope:

- Privatizing the seven hoisted registry members.
- Moving [`src/http-policy.ts`](../../../src/http-policy.ts) under
  `src/transport/`, where the MCP spec puts authorization.
- The five unused exports inside `__tests__` helper files. Step 5's `project`
  scope excludes them by design.

Nothing is committed. `git checkout -- .` reverts the whole run.
