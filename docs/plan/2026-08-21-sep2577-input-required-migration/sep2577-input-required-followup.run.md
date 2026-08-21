# Run: harden SEP-2577 grant concurrency and retire the R9 boilerplate

Executing [`sep2577-input-required-followup.plan.md`](sep2577-input-required-followup.plan.md),
started 2026-08-21 at `cf4f255` (branch `sep2577-input-required`, work uncommitted).

- **1** 2026-08-21 — done. Added a one-slot `#mutex` + `runExclusive` to `PathGuard`;
  split `setRoots` into `#setRootsLocked` (public `setRoots` wraps it under the lock);
  `applyGrant` reads `getAllowedDirectories()` + writes under the lock. Also
  `prettier --write` on the 4 new doc files. `node scripts/tasks.mjs --quick` → 4/4;
  `node scripts/tasks.mjs` → 6/6.
- **2** 2026-08-21 — done. Moved `precheckGrant` inside `runTool`'s try/catch
  (`define.ts:342`) so an R9 grant-set mismatch throws into `failProgress` →
  `isError` tool result, not a raw JSON-RPC `-32602` (GRANT-1 impact #2).
  Updated `access-grant.test.ts:186-194` R9 from `assert.rejects` to an `isError`
  assertion. `node scripts/tasks.mjs` → 6/6.
- **3** 2026-08-21 — done. Added `pendingRoundTrip` to
  [`input-required.ts`](../../../src/tools/input-required.ts) (owns the
  read-state → `buildInputRequired` → R9 mismatch-throw flow); called it from
  `define.precheckGrant`, `delete-file.handleDelete`, `move.handleMove`.
  Un-exported `pathsEqual` (now internal-only); dropped now-unused imports
  (`buildInputRequired`/`pathsEqual`/`PendingState`/`FsError` where no longer
  needed). Move's R9 message unified to "…requested paths". `node
scripts/tasks.mjs` → 6/6.
- **4** 2026-08-21 — done. Added private `PathGuard#isWithinBoundary` (path.ts,
  after `applyGrant`); `precheckAccess`'s boundary block replaced with
  `if (!(await this.isWithinBoundary(targetDir))) continue;`, `applyGrant`'s
  with `if (!(await this.isWithinBoundary(targetDir))) return false;`.
  `node scripts/tasks.mjs` → 6/6.
- **5** 2026-08-21 — done. Moved the duplicated direct-handler stub harness
  (`registerAgainstStub`, `NO_CTX`, `CapturedHandler`, `RegisteredShape`,
  `retryCtx`, `retryState`, `accept`) into `__tests__/helpers.ts`;
  `registerAgainstStub` takes an optional `init` override (defaults to
  `initialize`) — `elicitation.test.ts` passes `(pg, r) => pg.setRoots([r])` at
  both call sites to keep ROOT_BOUNDARY resolution. Deleted the five local
  copies and renamed `deleteCtx`/`moveCtx`/`grantCtx`/`ctx`/`eraContext` call
  sites to `retryCtx`. Net ~205 lines removed / ~65 added. `prettier --write`
  on `helpers.ts`. `node scripts/tasks.mjs` → 6/6.
- **6** 2026-08-21 — done. Added R2 two-pending tests: `delete-file.test.ts`
  deletes `[dirA, dirB]` (both non-empty) in one call, asserts one
  `input_required` with `['confirm_0','confirm_1']` and both dirs untouched in
  round 1, both deleted on accept; `move.test.ts` two overwrites in one call,
  same shape. Both passed on first run — no R2 defect. `node
scripts/tasks.mjs` → 6/6.
- **7** 2026-08-21 — STOP (per plan, not an execution failure). Added the R12
  malformed-response test to `delete-file.test.ts` (`node scripts/tasks.mjs` →
  6/6, including it): accept with no `confirm` field does not delete the dir.
  Empirically confirmed against `dist` the observed shape is
  `{ isError: undefined, structuredContent: { ok: false, failures: [{ error:
{ code: 'CANCELLED' } }] } }` — no thrown error, no `isError`. Per the
  plan's explicit deferral, recorded as a spec delta on R12
  ([sep2577-input-required.spec-delta.md](sep2577-input-required.spec-delta.md))
  rather than treated as a code bug (the operation _did not proceed_, which is
  R12's substance — only the "returns an error" wording doesn't match).
  Stopping here for the operator to decide between amending R12's wording or
  changing the code to surface a distinct error for malformed vs. declined
  responses.
  **Resolved 2026-08-21** — operator chose to amend the wording. R12 in
  `sep2577-input-required.spec.md` updated to require "not performed, reported
  cancelled (or an error), never a success"; the spec delta marked resolved.
