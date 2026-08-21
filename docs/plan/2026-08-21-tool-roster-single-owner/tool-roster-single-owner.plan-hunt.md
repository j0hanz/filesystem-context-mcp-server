# Plan hunt: tool-roster-single-owner

Hunted [`tool-roster-single-owner.plan.md`](tool-roster-single-owner.plan.md)
against the repo at `606f71c`, 2026-08-21.

Three candidates raised, each sent to its own blind refuter (`general-purpose`,
plan and repo only, hunter's reasoning withheld). **One killed, two confirmed.**
Both confirmed findings have been fixed in the plan; the plan is re-verified and
clear for [run-plan](https://github.com/j0hanz/workbench/tree/main/skills/run-plan).

| #   | Finding                                       | Step | Verdict   | Status |
| :-- | :-------------------------------------------- | :--- | :-------- | :----- |
| 1   | Step 7 strands a binding its own gates reject | 7    | confirmed | fixed  |
| 2   | A Done checkbox could never be ticked         | Done | confirmed | fixed  |

---

## 1. Step 7 stranded a binding that the plan's own gates reject — confirmed

**What the step said.** Step 7 instructed the executor to switch
[`src/prompts.ts:383`](../../../src/prompts.ts#L383) from
`instructions: serverInstructionsContent` to
`instructions: buildServerInstructions(deps.readOnly)`, and — separately — to
keep the exports at `src/resources.ts:165-169` "exactly as they are".

**Why it was dead.** Those two instructions contradict each other. The refuter
ruled it out independently and found the failure is doubled:

- [`src/prompts.ts:28`](../../../src/prompts.ts#L28) is
  `import { INSTRUCTION_SECTIONS, serverInstructionsContent } from './resources.js';`
  and a repo-wide search returns exactly two hits for `serverInstructionsContent`
  in `src/` — that import and line 383. Rewriting 383 alone leaves the specifier
  unread, and [`tsconfig.json:31`](../../../tsconfig.json#L31) sets
  `"noUnusedLocals": true` → TS6133 → `npm run type-check` exits non-zero.
- [`src/resources.ts:169`](../../../src/resources.ts#L169) is
  `export { SERVER_INSTRUCTIONS_CONTENT as serverInstructionsContent };`, and
  `prompts.ts` was its only importer repo-wide. Orphaned, it lands in knip's
  default `exports` report — [`knip.json`](../../../knip.json) sets
  `"project": ["src/**/*.ts"]` with no `ignoreExportsUsedInFile`, and the `knip`
  script passes no issue-type filter.

**The step's own justification was wrong.** It kept line 169 because "ten
assertions in `__tests__/resources/instructions.test.ts` read them" — but
[`instructions.test.ts:4`](../../../__tests__/resources/instructions.test.ts#L4)
imports the **un-aliased** `SERVER_INSTRUCTIONS_CONTENT`. No test reads the
alias.

**No gate would have caught it.** Step 7's only Verify was `npm test`, which
exercises neither `noUnusedLocals` nor knip.

**Fix applied.** Step 7 now carries a three-row fate table naming which export
survives and why; spells out both `prompts.ts` edits (line 28 specifier swap and
line 383) as one change; instructs deleting the line 169 alias with the knip
reasoning inline; and its Verify runs `npm run type-check` and `npm run knip`
before `npm test`.

## 2. A Done checkbox could never be ticked — confirmed

**What the plan said.** `- [ ] node scripts/tasks.mjs --quick exits 0`, with
Step 0 clearing the format gate by running
`./node_modules/.bin/prettier --write src/core/`.

**Why it was dead.** [`.prettierignore`](../../../.prettierignore) is two lines
in full — `node_modules` and `dist` — so `prettier --check .` reaches
`docs/**/*.md`, and the plan document is not gitignored either. The refuter ran
the repo's own binary and got `[warn] Code style issues found in 11 files` — the
eleventh being this plan itself, with real content differences (markdown table
padding, code-fence indentation), not line endings.

`format` is the first phase of the task runner and gates the rest
([`tasks.mjs:2014-2017`](../../../scripts/tasks.mjs#L2014-L2017)); `--quick`
skips only test and rebuild, never format. So after Step 0 landed its ten
`src/core/` files, the checkbox still failed — on the plan document.

**The plan forbade its own remedy.** Its STOP list read "Step 0's
`prettier --write` touches any file outside `src/core/`, or more than ten
files", which would have fired on the executor's only way to clear it.

**Fix applied.** Step 0 now runs
`./node_modules/.bin/prettier --write src/core/ docs/` and stages both; the
toolchain section reports 11 files and explains the eleventh; the STOP condition
was widened to match.

**Verified after the fix**: `node scripts/tasks.mjs --quick` → exit 0, with
`format`, `knip`, `type-check`, and `lint` all passing. `src/core/` was reverted
afterwards; the repository sits at `606f71c` with only untracked `docs/`.

---

## Dismissed without dispatch

Checked against the tells and settled in-thread, so no refuter was spent:

| Claim checked                                                       | Settled by                                                             |
| :------------------------------------------------------------------ | :--------------------------------------------------------------------- |
| Step 5 deletes twelve imports from `helpers.ts`                     | Each name appears exactly twice — its import and the `ALL_TOOLS` array |
| Step 6 deletes five imports from `resources.ts`                     | Each appears only at its import line and line 120                      |
| Step 7's substring assertions on `create`, `move`, `edit`, `delete` | Each occurs exactly once in the generated text, in the `Write` row     |
| Step 6 module-init order in `cli.ts`                                | Nothing under `src/tools` or `src/core` imports `cli.ts` — no cycle    |
| `ResourceRegistrationOptions` exists                                | [`src/resources.ts:58`](../../../src/resources.ts#L58)                 |
| `__tests__/unit/tool-roster.test.ts` collides                       | Path does not exist; runner glob `__tests__/**/*.test.ts` discovers it |
| Oracle partitions the roster                                        | 5 + 7 = 12, names match the registered set exactly                     |
| `pass 803` / `pass 805` counts                                      | Baseline is `tests 802 / pass 801`; two tests per step, so both hold   |

## Killed

One candidate was refuted and dropped. Per protocol it is not reported here.

## Hunter's note

This hunt was run by the plan's own author, which is the weakest position to
hunt from — every finding above came from checking a claim against the repo
rather than from re-reading the prose, and the two that landed were both places
where the plan asserted something about the repo that was not true. Finding 2
was raised only because a Done-list command was executed rather than assumed.

A second-order failure is worth recording: the first fix for Finding 2 widened
Step 0 without widening the STOP condition that forbade it, leaving the plan
self-contradictory. The refuter caught that, not the author.
