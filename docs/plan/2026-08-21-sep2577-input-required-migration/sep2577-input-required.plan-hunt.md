# Plan-hunt: migrate destructive confirmations to input_required

Hunting [`sep2577-input-required.plan.md`](sep2577-input-required.plan.md), amended
2026-08-21 after Step 8 STOPped. Steps 1–7 are executed (owned by
[`sep2577-input-required.run.md`](sep2577-input-required.run.md)); this hunt covers
the amended Steps 8–11, the era constraint in Current state, and the amended
Scope/Done/STOP/Drift. Two candidates raised, one blind refuter each.

## Findings

### Confirmed — Step 9: the `InputRequiredResult` import breaks the `--quick` lint gate

Step 9 instructs adding `InputRequiredResult` to the type import at
[`__tests__/unit/corehandler-return-type.test.ts:2`](../../../__tests__/unit/corehandler-return-type.test.ts#L2)
"so a reader sees the widened type the regex now expects." After the regex widen,
`InputRequiredResult` appears only inside regex literals
([`:22`](../../../__tests__/unit/corehandler-return-type.test.ts#L22),
[`:36`](../../../__tests__/unit/corehandler-return-type.test.ts#L36)) — regex text is
not an identifier reference, so the import is unused.

[`eslint.config.mjs:57-58`](../../../eslint.config.mjs#L57-L58) sets
`'@typescript-eslint/no-unused-vars': ['error', …]` in the file-unscoped
`project/common-rules` block; `project/tests`
([`:156-181`](../../../eslint.config.mjs#L156-L181)) overrides many rules but not
`no-unused-vars`, so `error` carries through to test files.
[`scripts/tasks.mjs`](../../../scripts/tasks.mjs) runs `lint` with no `--quick` skip
(only `test` and `rebuild` skip under `--quick`), so Step 9's Verify
(`node scripts/tasks.mjs --quick` → exit 0) cannot pass as written.

> Note: the original claim's knip pillar was false — knip's parser rules have no
> "imports" category, so knip does not flag unused imports. The eslint pillar alone
> confirms the gate failure.

**Fix (write-plan owns it):** drop the "add `InputRequiredResult` to the type
import" instruction from Step 9. The regex widening is the entire fix; no import is
needed (the test's second case uses `CallToolResult`, not `InputRequiredResult`).

### Killed — Step 10: the `assertInputRequiredFailClose` param type is NOT a type error

The helper's parameter `{ isError?: boolean; content?: { text?: string }[] }` accepts
a `CallToolResult`: `ContentBlock` is a union whose only `text`-bearing member is the
text variant (`text: string`); every other member omits `text` entirely. Under TS
structural typing a member with no `text` IS assignable to `{ text?: string }`
(optional properties may be missing), and `text: string` is assignable to
`string | undefined`. So `ContentBlock[]` is assignable to `{ text?: string }[]` — no
call-site type error. (Body is safe too: `const text = raw.content?.[0]?.text ?? ''`
narrows to `string` before `.includes`.) Killed by the refuter.

Residual, non-blocking: the bespoke param type deviates from the file's `unknown` +
`const r = result as ToolResult` convention used by `assertToolError`/`assertOk`/
`getStructured`. It does not break a gate; left as a style note, not a defect.

## Verdict

One confirmed defect (Step 9), handed to write-plan for a one-line fix (remove the
import instruction). No other dead steps. Re-hunt of the one-line removal is skipped
— it removes an instruction and introduces no new API, path, or convention.
Forwarding to [run-plan](../run-plan/SKILL.md) at Step 8 after the fix lands.
