# Plan: harden SEP-2577 grant concurrency and retire the R9 boilerplate

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `cf4f255`, 2026-08-21, branch `sep2577-input-required`
> (all migration work is uncommitted in the working tree).
> **Drift check (run first)**: `git diff --stat cf4f255..HEAD -- src/core/path.ts src/tools/define.ts`
> — empty (work is uncommitted); confirm the excerpts below against the live
> working tree instead. A mismatch between a [Current state](#current-state)
> excerpt and the live file is a [STOP](#stop).

## Goal

The SEP-2577 migration landed green and behavior-verified, but three reviewers
flagged follow-ups: bug-hunt GRANT-1 (an unsynchronized read-`await`-write in
`applyGrant`→`setRoots` that can lose a user-accepted grant and surface a legit
retry as a raw JSON-RPC error), qc (the R9 round-trip boilerplate triplicated
across three handlers, a 5-file copy-pasted test stub harness, and the grant
pre-check sitting outside the handler error envelope), and verify-specs (R2 and
R12 never observed — no two-pending integration test, no malformed-response
test). This plan lands the concurrency hardening, the structural refactors, and
the two missing tests. Requirements covered: [`R2`](sep2577-input-required.spec.md#requirements),
[`R9`](sep2577-input-required.spec.md#requirements), [`R12`](sep2577-input-required.spec.md#requirements).

## Current state

The facts, inlined — every excerpt readable without opening another document:

- [`src/core/path.ts:473-485`](../../../src/core/path.ts#L473-L485) — `setRoots`
  is the single mutating entry: sets `this.rootDirectories`, `await`s
  `recomputeAllowedDirectories`, rolls back on throw. No lock.
  ```ts
  async setRoots(resolvedRoots: readonly string[]): Promise<void> {
    const next = [...resolvedRoots];
    const previous = this.rootDirectories;
    this.rootDirectories = next;
    try { await this.recomputeAllowedDirectories(); }
    catch (error) { this.rootDirectories = previous; throw error; }
  }
  ```
- [`src/core/path.ts:608-620`](../../../src/core/path.ts#L608-L620) — `applyGrant`
  reads `getAllowedDirectories()` (sync, [path.ts:487](../../../src/core/path.ts#L487))
  then `await this.setRoots([...getAllowedDirectories(), targetDir])`. The read
  is outside any lock, so two concurrent grants read the same snapshot and the
  second write wins (GRANT-1). Boundary block duplicated with `precheckAccess`.
  ```ts
  async applyGrant(targetDir: string): Promise<boolean> {
    if (this.rootBoundaries.length > 0) {
      let resolvedTarget: string;
      try { resolvedTarget = normalizePath(await realpath(targetDir)); }
      catch { resolvedTarget = normalizePath(targetDir); }
      if (!isPathWithinDirectories(resolvedTarget, this.rootBoundaries)) return false;
    }
    await this.setRoots([...this.getAllowedDirectories(), targetDir]);
    return true;
  }
  ```
- [`src/core/path.ts:582-594`](../../../src/core/path.ts#L582-L594) — `precheckAccess`
  runs the same `realpath → normalize → isPathWithinDirectories` boundary block.
- [`src/tools/define.ts:335-360`](../../../src/tools/define.ts#L335-L360) —
  `execute` calls `precheckGrant()` at line 357 **before** `runTool()` at 359.
  `runTool`'s try/catch (336-351) wraps only `this.def.run`, so the R9
  `FsError(INVALID_INPUT)` from `precheckGrant`
  ([define.ts:310-314](../../../src/tools/define.ts#L310-L314)) propagates out of
  `execute` to the SDK as a raw JSON-RPC `-32602`, while every failure inside
  `run` surfaces as an `isError` result — two error contracts for one handler.
  ```ts
  const grantRequired = await this.precheckGrant();
  if (grantRequired !== undefined) return grantRequired;
  return runTool();
  ```
- [`src/tools/define.ts:301-315`](../../../src/tools/define.ts#L301-L315),
  [`src/tools/delete-file.ts:299-322`](../../../src/tools/delete-file.ts#L299-L322),
  [`src/tools/move.ts:250-268`](../../../src/tools/move.ts#L250-L268) — the same
  control flow in three places: read `requestState` → if absent
  `buildInputRequired({op, paths: pending}, inputs)` → else if
  `state.op !== op || !pathsEqual(state.paths, pending)` throw
  `FsError(INVALID_INPUT, '${op}: confirmation does not match the requested paths')`.
  Only the op literal and the input-message builder vary.
- [`src/tools/input-required.ts:80-109`](../../../src/tools/input-required.ts#L80-L109)
  — `confirmInput` (pass-through `{ key, message }`), `buildInputRequired`,
  `pathsEqual` ([134-138](../../../src/tools/input-required.ts#L134-L138)); the
  canonical home for the round-trip helpers. Errors follow the pattern in
  [`delete-file.ts:9`](../../../src/tools/delete-file.ts#L9): `import { ErrorCode, FsError } from '../core/errors.js'`.
- [`__tests__/tools/access-grant.test.ts:185-189`](../../../__tests__/tools/access-grant.test.ts#L185-L189)
  — the grant R9 test asserts a **rejection**:
  `await assert.rejects(handler({ path: fileY }, grantCtx({ responses: accept(), state })), /match the requested paths/)`.
  Step 2 makes this throw an `isError` result instead, so this assertion must
  change with it.
- [`__tests__/tools/access-grant.test.ts:41-70`](../../../__tests__/tools/access-grant.test.ts#L41-L70),
  [`__tests__/tools/delete-file.test.ts:42-71`](../../../__tests__/tools/delete-file.test.ts#L42-L71),
  [`__tests__/tools/move.test.ts`](../../../__tests__/tools/move.test.ts),
  [`__tests__/tools/elicitation.test.ts`](../../../__tests__/tools/elicitation.test.ts),
  [`__tests__/tools/elicitation-era.test.ts:36-65`](../../../__tests__/tools/elicitation-era.test.ts#L36-L65)
  — `registerAgainstStub`, `NO_CTX`, `RegisteredShape`, `CapturedHandler`,
  `retryState`, `accept`, and a per-file `ctx()` factory are duplicated verbatim
  (the five ctx factories are byte-identical except the name; `elicitation.test.ts`
  uses `setRoots` instead of `initialize` for its ROOT_BOUNDARY test).
  [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) has no such harness today.

## Commands

| Purpose | Command                          | Expected on success                           |
| ------- | -------------------------------- | --------------------------------------------- |
| Static  | `node scripts/tasks.mjs --quick` | format, lint, type-check, knip all pass (4/4) |
| Full    | `node scripts/tasks.mjs`         | all 6 phases pass, including every test       |

## Scope

**In scope** — the only files to modify:

- [`src/core/path.ts`](../../../src/core/path.ts) — mutex (step 1), `isWithinBoundary` (step 4)
- [`src/tools/define.ts`](../../../src/tools/define.ts) — envelope (step 2), helper call (step 3)
- [`src/tools/input-required.ts`](../../../src/tools/input-required.ts) — `pendingRoundTrip` (step 3)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) — helper call (step 3)
- [`src/tools/move.ts`](../../../src/tools/move.ts) — helper call (step 3)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) — extracted stub harness (step 5)
- [`__tests__/tools/access-grant.test.ts`](../../../__tests__/tools/access-grant.test.ts) — use harness, R9 rejects→isError (steps 2, 5)
- [`__tests__/tools/delete-file.test.ts`](../../../__tests__/tools/delete-file.test.ts) — use harness, R2 + R12 tests (steps 5, 6, 7)
- [`__tests__/tools/move.test.ts`](../../../__tests__/tools/move.test.ts) — use harness, R2 test (steps 5, 6)
- [`__tests__/tools/elicitation.test.ts`](../../../__tests__/tools/elicitation.test.ts) — use harness (step 5)
- [`__tests__/tools/elicitation-era.test.ts`](../../../__tests__/tools/elicitation-era.test.ts) — use harness (step 5)

**Files out of scope** — leave alone even though they look related:

- The 11 `accessPaths` one-liners and `src/core/schema.ts` — correct as wired; `validateAccess` is the hard gate.
- `src/server.ts`, `src/transport.ts` — per-session `PathGuard` already confirmed; no change.
- `src/cli.ts`, `README.md` — env docs landed; no change.
- `src/tools/progress.ts` — flush semantics confirmed safe (step 2 note); no change.

## Steps

### 1. Serialize PathGuard root mutation with a one-slot async mutex

Add a minimal one-slot async mutex to `PathGuard` (no new dependency — the repo
has none and doesn't need one). Split `setRoots` into a locked internal so the
read-`await`-write becomes atomic at the mutation seam, and run `applyGrant`'s
read+write under the same lock so two concurrent grants cannot interleave.

- Add a `#mutex = Promise.resolve();` field and a private
  `runExclusive<T>(fn: () => Promise<T>): Promise<T>` that chains `fn` onto the
  tail and updates the tail swallowing rejections.
- Rename the current `setRoots` body to `async #setRootsLocked(resolvedRoots)` (no
  behavior change). Public `setRoots(resolvedRoots)` becomes
  `return this.runExclusive(() => this.#setRootsLocked(resolvedRoots));`.
- `applyGrant`: keep the boundary block for now (step 4 dedups it), but wrap the
  read+write: `return this.runExclusive(async () => { await
this.#setRootsLocked([...this.getAllowedDirectories(), targetDir]); return
true; });`. The `getAllowedDirectories()` read is now inside the lock, so a
  second grant sees the first's write. (`#setRootsLocked` does not re-acquire —
  `runExclusive` is not reentrant, which is correct here.)

```ts
// ponytail: one mutex per PathGuard. If per-session grant throughput ever
// matters, split into per-grant-dir locks; a single lock is correct for the
// stdio + InMemoryEventStore single-process model (decision record 11).
```

**Verify**: `node scripts/tasks.mjs` → 6/6 (the access-grant R8 test exercises
`setRoots`; no regression). The race itself is not unit-testable without a flaky
concurrency harness — the fix is structural; see Notes.

### 2. Route the grant pre-check through the handler error envelope

Move the `precheckGrant()` call from `execute` (line 357) to the top of
`runTool`'s `try` block, before `this.def.run`. A grant `input_required` still
short-circuits (return it verbatim — the existing
`if (isInputRequiredResult(result)) return result` semantics), but the R9
`FsError` now lands in `runTool`'s `catch` → `failProgress` → an `isError` tool
result, matching every other handler failure. This is GRANT-1 impact #2 and qc
blocking #3.

```ts
const runTool = async (): Promise<CallToolResult | InputRequiredResult> => {
  try {
    const grantRequired = await this.precheckGrant();
    if (grantRequired !== undefined) return grantRequired;
    const result = await this.def.run(this.parsedArgs, this.toolCtx);
    if (isInputRequiredResult(result)) return result;
    await this.completeProgress(result.structured);
    return buildSuccessResponse(result);
  } catch (error) {
    return await this.failProgress(error);
  } finally {
    await this.#flushProgress();
  }
};
return runTool();
```

Delete the old `const grantRequired = …; if (…) return …;` lines from `execute`.
The grant `input_required` path now runs `runTool`'s `finally` (`#flushProgress`),
which only flushes the MCP notification sink (does not complete/fail the session)
— aligning it with the delete/move round-1 path; confirmed safe in recon.

Update [`__tests__/tools/access-grant.test.ts:185-189`](../../../__tests__/tools/access-grant.test.ts#L185-L189):
the R9 test can no longer `assert.rejects`. Replace with an `isError` assertion:

```ts
const r2 = (await handler({ path: fileY }, grantCtx({ responses: accept(), state }))) as {
  isError?: boolean;
  content?: { text?: string }[];
};
assert.equal(r2.isError, true, 'a mismatched grant retry is rejected as a tool error');
assert.ok(r2.content?.[0]?.text?.includes('match the requested paths'));
```

Keep the `r3` (Y not granted) assertions unchanged. The delete R9 test
([delete-file.test.ts:278](../../../__tests__/tools/delete-file.test.ts#L278))
already asserts `isError: true` — no change.

**Verify**: `node scripts/tasks.mjs` → 6/6.

### 3. Extract `pendingRoundTrip`, retire the triplicated R9 block

Add one helper to [`src/tools/input-required.ts`](../../../src/tools/input-required.ts)
owning the read-state → `buildInputRequired` → mismatch-throw flow, and call it
from all three sites. This is a security-critical binding check — one home means
a future fix can't miss two of three sites.

- Add `import { ErrorCode, FsError } from '../core/errors.js';`.
- Add:
  ```ts
  export interface PendingRoundTripOpts {
    readonly op: PendingOp;
    readonly pending: readonly string[];
    readonly requestState: (() => PendingState | undefined) | undefined;
    readonly buildInputs: (pending: readonly string[]) => PendingInput[];
  }
  export async function pendingRoundTrip(
    opts: PendingRoundTripOpts,
  ): Promise<InputRequiredResult | undefined> {
    const state = opts.requestState ? opts.requestState() : undefined;
    if (!state) {
      return buildInputRequired(
        { op: opts.op, paths: opts.pending },
        opts.buildInputs(opts.pending),
      );
    }
    if (state.op !== opts.op || !pathsEqual(state.paths, opts.pending)) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `${opts.op}: confirmation does not match the requested paths`,
      );
    }
    return undefined;
  }
  ```
- `define.ts` `precheckGrant` (after computing `grantDirs`): replace lines 301-315
  with `const r = await pendingRoundTrip({ op: 'grant', pending: grantDirs, requestState: this.toolCtx.requestState, buildInputs: dirs => dirs.map((d, i) => confirmInput(\`confirm_${i}\`, \`Grant filesystem access to "${d}"?\`)) }); if (r !== undefined) return r;` then keep the apply-grants loop (318-323).
- `delete-file.ts` `handleDelete` (301-322): replace with `const r = await pendingRoundTrip({ op: 'delete', pending: pendingSorted, requestState: ctx.requestState, buildInputs: ps => ps.map((p, i) => confirmInput(\`confirm_${i}\`, \`Permanently delete "${p}" and all its contents? This cannot be undone.\`)) }); if (r !== undefined) return r;`. Keep the `pendingSorted` computation (299) and phase-2 (324+).
- `move.ts` `handleMove` (250-268): same shape with `op: 'move'`, `pending: pendingSorted`, message `"${d}" already exists. Overwrite it?`.

The throw now lives in one place; for delete/move it is inside `def.run`
(runTool catch → `isError`), and for grant it is inside `runTool` after step 2.
All three R9 paths uniformly surface as `isError` results.

**Verify**: `node scripts/tasks.mjs` → 6/6.

### 4. Extract `isWithinBoundary`, deduplicate the grant boundary check

Add one private helper to `PathGuard` and use it in both grant paths:

```ts
private async isWithinBoundary(targetDir: string): Promise<boolean> {
  if (this.rootBoundaries.length === 0) return true;
  let resolved: string;
  try { resolved = normalizePath(await realpath(targetDir)); }
  catch { resolved = normalizePath(targetDir); }
  return isPathWithinDirectories(resolved, this.rootBoundaries);
}
```

- `precheckAccess` (582-594): replace the `if (this.rootBoundaries.length > 0) { … }` block with `if (!(await this.isWithinBoundary(targetDir))) continue;`. (When there are no boundaries the helper returns `true`, so the dir is still pushed — unchanged.)
- `applyGrant` (609-616): replace the boundary block with `if (!(await this.isWithinBoundary(targetDir))) return false;`. The `runExclusive` wrapper from step 1 stays around the read+`#setRootsLocked`.

**Verify**: `node scripts/tasks.mjs` → 6/6 (the ROOT_BOUNDARY test,
[`elicitation.test.ts:139`](../../../__tests__/tools/elicitation.test.ts#L139), exercises both paths).

### 5. Extract the direct-handler stub harness to `__tests__/helpers.ts`

Move the duplicated stub to [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) and import it from the five
test files. Net deletion (~200 lines removed, ~60 added).

- Add to `helpers.ts`: `CapturedHandler` and `RegisteredShape` types, `NO_CTX`,
  `retryState(round1)`, `accept(confirm?)`, a shared `retryCtx(opts)` returning the
  `{ mcpReq: { signal, notify, log, inputResponses, requestState } }` context, and
  `registerAgainstStub(tool, root, init?)` where `init` defaults to
  `pathGuard.initialize(await resolveAllowedDirectoriesState([root]))`.
- `elicitation.test.ts`'s ROOT_BOUNDARY test passes `init: async (pg, root) =>
pg.setRoots([root])` (its one-line override). After step 1, `setRoots` is the
  public locked entry — call it, not `#setRootsLocked`.
- In each of the five files: delete the local `registerAgainstStub`/`NO_CTX`/
  `RegisteredShape`/`CapturedHandler`/`retryState`/`accept`/ctx-factory and import
  them from `../helpers.js`. Rename call sites' `deleteCtx`/`moveCtx`/`grantCtx`/
  `eraContext` to `retryCtx` (or keep a one-line local alias if a test reads
  better with the named factory — but prefer the shared name).

**Verify**: `node scripts/tasks.mjs` → 6/6 (all five files' tests still pass off the shared harness).

### 6. Add R2 two-pending integration tests

[`R2`](sep2577-input-required.spec.md#requirements) is unmet because no
integration test fires two pending items in one call. Add:

- `delete-file.test.ts`: delete `[nonEmptyDirA, nonEmptyDirB]` (both non-empty) in
  one call. Assert round 1 is one `input_required`, both dirs still exist,
  `state.paths.length === 2` with both dirs, and `Object.keys(result.inputRequests).sort()`
  is `['confirm_0', 'confirm_1']`; on `accept()` retry, both dirs are deleted.
- `move.test.ts`: two moves whose destinations both exist (two overwrites) in one
  call. Assert one `input_required` with both `confirm_0`/`confirm_1`, neither
  destination overwritten in round 1; on accept, both move.

If a test fails, the code does not collect all pending items into one result —
that is a real R2 defect (hand to write-plan to fix the handler, not the test).

**Verify**: `node scripts/tasks.mjs` → 6/6, including the two new tests.

### 7. Add R12 malformed-response test

[`R12`](sep2577-input-required.spec.md#requirements) is an `If…then…` requirement
whose trigger was never fired. In `delete-file.test.ts`, after the round-1
`input_required` for a non-empty dir, retry with malformed `inputResponses` and
assert the operation does not proceed:

```ts
const r2 = await handler(
  { paths: [dir], recursive: true },
  retryCtx({
    responses: { confirm_0: { action: 'accept', content: {} } } as unknown as Record<
      string,
      unknown
    >,
    state,
  }),
);
assert.ok(existsSync(dir), 'malformed responses do not perform the delete');
const sc = structuredOf(r2);
assert.ok(!(sc.ok === true), 'a malformed retry does not succeed');
```

(Accept with no `confirm` field is malformed; `readAcceptedConfirm` returns
`false` → the item is reported `CANCELLED`, not performed.) Assert "no mutation +
not ok" — robust to either an `isError` result or an `ok:false` CANCELLED result.
If the observed behavior is `CANCELLED` rather than the spec's "returns an error,"
that is a spec-wording gap, not a code bug — record it as a [spec delta](sep2577-input-required.spec-delta.md)
on R12 and STOP for the operator to decide.

**Verify**: `node scripts/tasks.mjs` → 6/6, including the new test.

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0 (format, lint, type-check, knip)
- [ ] `node scripts/tasks.mjs` exits 0, including the new R2 (two-pending) and
      R12 (malformed-response) tests
- [ ] `git status` shows no files outside the in-scope list
- [ ] `grep -rn "did not declare the required capability" __tests__` unchanged
      (wire fail-close tests untouched); `grep -rn "elicitInput" src/tools` still 0

## STOP

Stop and report if:

- A [Current state](#current-state) excerpt does not match the live working tree.
- A step's verification fails twice after one fix attempt — the step's assumption
  is wrong, not its implementation.
- The R12 test reveals behavior the spec forbids (the operation proceeds on
  malformed responses) — that is a code bug, not a spec-delta question.
- The mutex or envelope change breaks a progress test — the progress-lifecycle
  reasoning in step 2 is load-bearing and a break means it is wrong.

## Notes

- **GRANT-1 concurrency test**: intentionally not added. A reliable same-session
  concurrent-grant test is flaky and the finding is fail-closed/self-healing
  (Minor); the mutex is a structural fix verified by no regression. If a future
  reviewer wants proof, a deterministic two-`Promise.all` grant test against the
  shared `PathGuard` (asserting both dirs end up allowed) is the shape — add when
  the concurrency axis is worth a flaky test.
- **`confirmInput` kept**: qc flagged it as a pass-through. Inlining
  `{ key, message }` at the call sites is optional churn; the named construction
  reads better for a security prompt and `pendingRoundTrip`'s `buildInputs`
  callbacks use it. Left as-is.
- **R12 spec wording**: the spec says "returns an error"; the code reports
  `CANCELLED` (`ok:false`) for non-accepted shapes. Step 7 asserts the
  observable ("not performed + not ok") and defers the wording question to the
  operator via a possible spec delta.
- **Ordering**: steps 1-2 are the security fix; 3-5 are behavior-preserving
  refactors; 6-7 add the missing test coverage. Each step leaves the suite green.
