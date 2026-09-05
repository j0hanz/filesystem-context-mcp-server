# Plan hunt: [`text-first-results.plan.md`](text-first-results.plan.md)

Hunted 2026-09-05 against commit `a7aa52d0`.

> **Resolved 2026-09-05.** All three confirmed findings were fixed in the plan:
> `failedSummary` added to Scope and the inventory with the repoint in step 2;
> `stat`'s text removal folded into step 1 and the old step 5 deleted (steps
> renumbered, 7 → 6); step 3's example corrected and the tail trailer keyed on
> `linesRead`. Not re-hunted — the plan has not been executed since.

**Drift**: none. `git diff --stat a7aa52d0..HEAD` over the plan's watched paths
is empty; every one of the 19 cited paths resolves under `git ls-files`.

**Baseline confirmed**: `node scripts/tasks.mjs test` → `tests 271 / pass 271 /
fail 0`, matching the plan's stated baseline.

**Excerpts checked**: every `Current state` location was opened. All code
excerpts match. Line anchors are exact at
[`define.ts:95-99`](../../../src/tools/define.ts#L95-L99),
[`:556`](../../../src/tools/define.ts#L556),
[`read.ts:159`](../../../src/tools/read.ts#L159),
[`:303`](../../../src/tools/read.ts#L303),
[`:308-310`](../../../src/tools/read.ts#L308-L310),
[`:397`](../../../src/tools/read.ts#L397),
[`list.ts:160`](../../../src/tools/list.ts#L160),
[`:384-393`](../../../src/tools/list.ts#L384-L393),
[`stat.ts:8`](../../../src/tools/stat.ts#L8),
[`:248-276`](../../../src/tools/stat.ts#L248-L276),
[`edit.ts:528-529`](../../../src/tools/edit.ts#L528-L529),
[`delete-file.ts:421-423`](../../../src/tools/delete-file.ts#L421-L423),
[`instructions.ts:72-73`](../../../src/instructions.ts#L72-L73).

3 findings confirmed, 2 candidates killed.

## Confirmed

### 1. `failedSummary` breaks six assertions in two unlisted files — steps 1, 2

Step 1 routes `read`'s structured half to `_meta`.
[`__tests__/helpers.ts:495-501`](../../../__tests__/helpers.ts#L495-L501)
exports a helper that reads the old field:

```ts
export function failedSummary(result: { structuredContent?: unknown }):
  ...
  return result.structuredContent as
```

The parameter is optional, so this keeps type-checking and returns `undefined`
silently. Six live call sites pass `read` results through it:
[`tools.test.ts:392`](../../../__tests__/tools.test.ts#L392) (TC-FUNC-015),
[`:419`](../../../__tests__/tools.test.ts#L419) (TC-FUNC-017),
[`:439`](../../../__tests__/tools.test.ts#L439) (TC-FUNC-021),
[`:481`](../../../__tests__/tools.test.ts#L481),
[`:493`](../../../__tests__/tools.test.ts#L493), and
[`http-transport.test.ts:73`](../../../__tests__/http-transport.test.ts#L73)
(HTTP-004).

`read` returns `text` unconditionally — including the all-paths-failed case at
[`read.ts:514-520`](../../../src/tools/read.ts#L514-L520) — and a total batch
failure still routes through `buildSuccessResponse`, so no result shape escapes.

Three consequences:

- Step 1's Verify is false: "failures only in the assertions listed under
  Current state ... **nothing else**". These six are not listed — the
  inventory at plan lines 106-128 enumerates only the *literal*
  `structuredContent` occurrences, and these read the field through the helper.
- Step 2's Verify (`fail 0`) is unreachable. Step 2 is scoped "at every line
  listed under Current state", so it never touches them.
- The Done gate "`git status` shows no modified files outside the in-scope
  list" cannot hold: the fix touches
  [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) and
  [`__tests__/http-transport.test.ts`](../../../__tests__/http-transport.test.ts),
  neither of which appears in the in-scope *or* out-of-scope list.

**Fix belongs to the author**: add both files to Scope, add the six sites to
the Current state inventory, and have step 2 repoint `failedSummary` to
`result._meta`.

### 2. `stat` drops its text too late — steps 2, 3, 4 gates unreachable

[`stat.ts:248`](../../../src/tools/stat.ts#L248) computes `text` and
[`:271`](../../../src/tools/stat.ts#L271) returns it, unconditionally. Step 1's
`hasText` branch therefore sends `stat`'s object to `_meta` and leaves
`structuredContent` undefined — from step 1 until step 5 removes the text.

Step 2 instructs: "Leave the stat cases ... as they are." Those four assertions
then throw or fail for three consecutive steps:
[`tools.test.ts:1206`](../../../__tests__/tools.test.ts#L1206),
[`:1226`](../../../__tests__/tools.test.ts#L1226),
[`:1247`](../../../__tests__/tools.test.ts#L1247) (all inside
`TC-FUNC-015s`, dereferencing `sc.results?.[0]?.value` on `undefined`), and
[`inspector-stdio.test.ts:215`](../../../__tests__/inspector-stdio.test.ts#L215).

Steps 2, 3 and 4 each demand `fail 0`. A cold executor stops at step 2's Verify
under the plan's own STOP: "A step's verification fails twice after one fix
attempt."

**Fix belongs to the author**: reorder — make the current step 5 (`stat`: drop
the lossy text summary) part of step 1, or move it directly after it, and
renumber the expected pass counts accordingly.

### 3. Step 3's worked example and tail sub-clause are unreachable — step 3

`totalLines` is assigned in exactly one place,
[`core/read.ts:669-677`](../../../src/core/read.ts#L669-L677) (`readFull`), and
that same object literal pins `hasMoreLines: false`. The three modes that can
set `hasMoreLines: true` — `readHead`, `readRange`, `readTail` — never set
`totalLines`, and nothing enriches it downstream.

Two halves of step 3 rest on it:

- **The worked example cannot be produced.**
  [`read.ts:179-182`](../../../src/tools/read.ts#L179-L182) always falls to
  `'File was truncated. Read next chunk with these args.'`, so a trailer built
  from `continuation.hint` can never read `4800 lines remain (201-5000)` as the
  step's example shows. The *format* survives and `TC-FUNC-074` still passes —
  its regex wildcards the hint with `.*` — so this misleads the executor
  without failing a gate.
- **The tail sub-clause is dead.** "emit `// truncated: showing last N of
  <totalLines> lines` for that case when `totalLines` is known" — never known
  for a tail read, so the `otherwise nothing` arm always wins. Combined with
  [`read.ts:308-310`](../../../src/tools/read.ts#L308-L310) suppressing
  `continuation` for tail, a truncated `tail` read emits no trailer at all and
  the model loses its only in-text signal that lines remain.

**Fix belongs to the author**: correct the example to the hint the code emits,
and either state plainly that tail gets no trailer, or emit
`// truncated: showing last <linesRead> lines` from `linesRead`, which tail
does populate.

## Killed

Reported for the record; neither is a defect.

- **`read.ts:394-397` deletion range.** The step names its target in prose
  ("the `publishOutputSchema: true` line and its comment"), and `:394` is
  neither. The plan pins `:397` independently under Current state, and step 1's
  own `--quick` gate compiles, so a mis-deletion of `output:` fails inside the
  step.
- **`tools.test.ts:1358-1380` citation for `TOOL-SURFACE-001`.** The range
  holds exactly what the bullet claims it holds; the bullet never says the test
  begins there, and it carries no excerpt for the STOP condition to mismatch.
  Step 2's own `1367-1388` is the exact block boundary.

## Verdict

**REQUEST_CHANGES** — 3 confirmed defects, 2 of them dead gates that halt a
cold executor at step 2. Back to `write-plan`; re-hunt or proceed after the
fixes. Do not hand this to `run-plan` as it stands.
