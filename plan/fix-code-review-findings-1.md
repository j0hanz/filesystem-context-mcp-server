# Implementation Plan: Fix Code Review Findings

## 1. Goal

Address all five findings surfaced in the `dev`→`main` code review: two test-breaking bugs that prevent the dist-runtime regression suite from loading, one structural security-design flaw in the delete tool, one wrong error type in the replace-in-files tool, and one test-helper duplication that creates maintenance drift risk. Completing this plan restores CI test coverage and tightens error handling.

## 2. Requirements & Constraints

REQ-001: The dist-runtime test suite must be able to import compiled modules and execute without `ERR_MODULE_NOT_FOUND` or `TypeError: … is not a function`.
REQ-002: `delete-file.ts` must call `pathGuard.validatePathForWrite()` explicitly in its per-path try-catch, matching the pattern in [`src/tools/move.ts`](src/tools/move.ts).
REQ-003: File-too-large errors in `replace-in-files.ts` must use `Problem.tooLarge()` so callers can inspect the structured error code.
CON-001: Do not change the public `toolsRegistrar` API surface; only the dist-runtime test wiring needs updating.
CON-002: The dist-runtime test skips at runtime if `dist/` is absent — preserve that guard.
PAT-001: Follow per-path error collection pattern from [`src/tools/move.ts:119-130`](src/tools/move.ts#L119).
PAT-002: Follow `Problem.tooLarge()` usage from [`src/core/errors.ts:87`](src/core/errors.ts#L87).

## 3. Current Context

**Relevant files:**

- [`__tests__/dist-runtime.test.ts`](__tests__/dist-runtime.test.ts) — dist-module regression test (currently broken)
- [`src/tools/index.ts`](src/tools/index.ts) — exports `toolsRegistrar` (a `Registrar`), not `registerAllTools`
- [`src/core/path.ts`](src/core/path.ts) — exports `PathGuard`, `resolveAllowedDirectoriesState`; has no `setAllowedDirectoriesResolved`
- [`src/core/registrar.ts`](src/core/registrar.ts) — `ServerDeps` interface (requires `pathGuard`, `orchestrator`)
- [`src/tools/delete-file.ts`](src/tools/delete-file.ts) — dead try-catch at line 154
- [`src/tools/replace-in-files.ts`](src/tools/replace-in-files.ts) — generic `Error` at line 313
- [`__tests__/helpers.ts`](__tests__/helpers.ts) — `ALL_TOOLS` array duplicated at lines 176 and 195
- [`src/core/errors.ts`](src/core/errors.ts) — `Problem.tooLarge()` factory at line 87, `ErrorCode.TOO_LARGE` at line 10

**Existing commands:**

```bash
npm run check          # build + typecheck + lint + format + knip + test
npm run type-check     # TypeScript only
npm test               # run all tests
node --test --import tsx __tests__/dist-runtime.test.ts  # single test file
```

**Current behavior:**

- `__tests__/dist-runtime.test.ts` crashes at import time: `dist/tools.js` does not exist (build emits `dist/tools/index.js`) and `setAllowedDirectoriesResolved` is never exported from `dist/core/path.js` (test references `dist/core/paths.js`, wrong filename).
- `delete-file.ts:153-158`: `try { validPath = inputPath; } catch` — the assignment cannot throw, so the catch for "path guard violation" is unreachable dead code; the intended `pathGuard.validatePathForWrite()` call was omitted.
- `replace-in-files.ts:313`: throws `new Error(...)` for file-too-large; loses `ErrorCode.TOO_LARGE` context.

## 4. Effort Estimation

**Total Duration**: 1–1.5 hours (5 tasks)

**Breakdown:**

- Average time per task: 15–20 minutes
- Team size: 1 developer
- Critical path: TASK-001 → TASK-002 (sequential within Phase 1); Phases 2–3 independent
- Parallelization: TASK-003, TASK-004, TASK-005 can run in parallel after Phase 1

## 5. Implementation Phases

---

### PHASE-001: Fix dist-runtime test — broken imports and missing API

**Goal:** `__tests__/dist-runtime.test.ts` loads cleanly and its `createDistEnv` helper correctly wires the compiled tools with a `PathGuard` instance.

#### TASK-001: Fix module paths and API call in `createDistEnv`

Depends on: none
Files: [`__tests__/dist-runtime.test.ts`](__tests__/dist-runtime.test.ts)
Symbols: [`createDistEnv`](__tests__/dist-runtime.test.ts#L43), [`DistToolsModule`](__tests__/dist-runtime.test.ts#L13), [`DistPathsModule`](__tests__/dist-runtime.test.ts#L23)

Action: Make three edits to `createDistEnv`:

1. **Line 44** — change `dist/tools.js` → `dist/tools/index.js`
2. **Lines 13–21** — replace the `DistToolsModule` interface: remove `registerAllTools`, instead type it as `{ toolsRegistrar: { register(deps: unknown): void } }`
3. **Line 70** — replace `toolsModule.registerAllTools(server, { resourceStore, isInitialized })` with `toolsModule.toolsRegistrar.register(deps)` where `deps` includes `server`, `pathGuard`, `resourceStore`, `isInitialized`, and `orchestrator` (constructed in TASK-002)

Validate: `npx tsc --noEmit -p tsconfig.test.json`
Expected result: No TypeScript errors in `__tests__/dist-runtime.test.ts`.

---

#### TASK-002: Replace `setAllowedDirectoriesResolved` with `PathGuard` init pattern

Depends on: [TASK-001](#task-001-fix-module-paths-and-api-call-in-createdistenv)
Files: [`__tests__/dist-runtime.test.ts`](__tests__/dist-runtime.test.ts)
Symbols: [`DistPathsModule`](__tests__/dist-runtime.test.ts#L23), [`resolveAllowedDirectoriesState`](src/core/path.ts#L398)

Action: Make these edits to `createDistEnv`:

1. **Line 45** — change `dist/core/paths.js` → `dist/core/path.js`
2. **Lines 23–25** — replace `DistPathsModule` interface: remove `setAllowedDirectoriesResolved`; add `PathGuard: new() => { initialize(state: unknown): void }` and `resolveAllowedDirectoriesState: (dirs: string[]) => Promise<unknown>`
3. **Line 55** — replace `await pathsModule.setAllowedDirectoriesResolved([tmpDir])` with:

   ```typescript
   const pathGuard = new pathsModule.PathGuard();
   const state = await pathsModule.resolveAllowedDirectoriesState([tmpDir]);
   pathGuard.initialize(state);
   ```

4. Pass `pathGuard` into the `deps` object constructed for `toolsRegistrar.register()` (from TASK-001).
5. For `orchestrator`: either import `TaskOrchestrator` from `dist/tasks.js` or pass a no-op stub `{ cleanup() {} }` since the dist test only exercises read-only tool calls.

Validate: `npm run build && node --test --import tsx __tests__/dist-runtime.test.ts`
Expected result: Test file loads without `ERR_MODULE_NOT_FOUND`; the single `grep from dist can search files` test runs (or skips if dist is missing) — no crash before reaching the `it(...)` body.

---

### PHASE-002: Fix source-level correctness bugs

**Goal:** `delete-file.ts` validates each path before use; `replace-in-files.ts` emits a typed error for file-too-large.

#### TASK-003: Add `pathGuard.validatePathForWrite()` to `deleteSinglePath`

Depends on: none
Files: [`src/tools/delete-file.ts`](src/tools/delete-file.ts)
Symbols: [`deleteSinglePath`](src/tools/delete-file.ts#L147)

Action: Replace the dead try-catch at lines 152–158:

```typescript
// BEFORE (dead code — assignment cannot throw):
let validPath: string;
try {
  validPath = inputPath;
} catch (error) {
  // Path guard violation: collect in failures[] instead of throwing
  return { failure: toDeleteFailure(inputPath, error) };
}

// AFTER (matches move.ts pattern):
let validPath: string;
try {
  validPath = await ctx.pathGuard.validatePathForWrite(inputPath);
} catch (error) {
  return { failure: toDeleteFailure(inputPath, error) };
}
```

This makes the catch branch reachable and ensures path-traversal or sensitive-file violations are surfaced as per-item `DeleteFailure` entries rather than bypassing the guard silently.

Validate: `npm run type-check && npm test -- --test-name-pattern delete`
Expected result: TypeScript clean; all delete-related tests pass.

---

#### TASK-004: Replace generic `Error` with `Problem.tooLarge()` in `replace-in-files.ts`

Depends on: none
Files: [`src/tools/replace-in-files.ts`](src/tools/replace-in-files.ts)
Symbols: [`Problem`](src/core/errors.ts#L87), [`ErrorCode.TOO_LARGE`](src/core/errors.ts#L10)

Action: Replace lines 312–316:

```typescript
// BEFORE:
if (stats.size > maxFileSize) {
  throw new Error(
    `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
  );
}

// AFTER:
if (stats.size > maxFileSize) {
  throw Problem.tooLarge(
    `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
    { path: validPath },
  );
}
```

`Problem` is already imported on line 12 of the file. `Problem.tooLarge()` produces a `Problem` instance carrying `ErrorCode.TOO_LARGE`, which the tool framework converts into a structured MCP error response with the code intact.

Validate: `npm run type-check && npm test -- --test-name-pattern "replace|search_and_replace"`
Expected result: TypeScript clean; replace-in-files tests pass.

---

### PHASE-003: Test helper cleanup

**Goal:** `ALL_TOOLS` list maintained in exactly one place in `__tests__/helpers.ts`.

#### TASK-005: Extract `ALL_TOOLS` to a module-level constant in `helpers.ts`

Depends on: none
Files: [`__tests__/helpers.ts`](__tests__/helpers.ts)
Symbols: [`createTestEnv`](__tests__/helpers.ts#L139), [`createTestEnvWithElicitation`](__tests__/helpers.ts#L243)

Action:

1. Add a module-level constant above `createTestEnv` (around line 138):

   ```typescript
   const ALL_TOOLS = [
     CALCULATE_HASH,
     CREATE,
     DELETE_FILE,
     EDIT,
     LIST,
     MOVE,
     READ_FILE,
     SEARCH_AND_REPLACE,
     LIST_ALLOWED_DIRECTORIES,
     SEARCH_CONTENT,
     SEARCH_FILES,
     GET_FILE_INFO,
   ] as const;
   ```

2. Remove the inline `const ALL_TOOLS = [...]` array at lines 176–208 inside `createTestEnv`.
3. Remove the inline `const ALL_TOOLS = [...]` array at lines 195–208 inside `createTestEnvWithElicitation`.
4. Both functions now reference the shared constant.

Validate: `npm test`
Expected result: All tests pass; no duplicate identifier errors.

---

## 6. Testing & Validation

[VAL-001](#6-testing--validation): `npm run build` completes with exit code 0 — confirms `dist/tools/index.js` and `dist/core/path.js` exist at the paths the updated dist-runtime test expects.
[VAL-002](#6-testing--validation): `node --test --import tsx __tests__/dist-runtime.test.ts` runs without a module-load crash.
[VAL-003](#6-testing--validation): `npm test` passes all tests (zero failures).
[VAL-004](#6-testing--validation): `npm run type-check` exits 0 with no new type errors.

## 7. Acceptance Criteria

[AC-001](#7-acceptance-criteria): `__tests__/dist-runtime.test.ts` no longer crashes before reaching any `it()` body.
[AC-002](#7-acceptance-criteria): `src/tools/delete-file.ts:deleteSinglePath` calls `ctx.pathGuard.validatePathForWrite(inputPath)` before any filesystem operation.
[AC-003](#7-acceptance-criteria): `src/tools/replace-in-files.ts` file-too-large path throws a `Problem` instance with `code === ErrorCode.TOO_LARGE`.
[AC-004](#7-acceptance-criteria): `__tests__/helpers.ts` contains exactly one `ALL_TOOLS` declaration (module-level).
[AC-005](#7-acceptance-criteria): `npm run check` exits 0 (build + typecheck + lint + format + knip + test all pass).

## 8. Design Decisions & Trade-Offs

[DECISION-001](#8-design-decisions--trade-offs): Update the dist-runtime test rather than adding `setAllowedDirectoriesResolved` back to `src/core/path.ts` — Why: the global singleton pattern was intentionally replaced with per-instance `PathGuard`; re-adding it would reintroduce a removed design.
[DECISION-002](#8-design-decisions--trade-offs): Use `Problem.tooLarge()` over a bare `FsError` — Why: `Problem` factory methods are the established pattern for user-facing errors in this codebase and include the `hint` field for recovery guidance.

## 9. Rollback Strategy

**Trigger**: Any of AC-001–AC-005 fails after merging.
**Action**: `git revert HEAD` — all five tasks are behaviour-preserving (no API surface changes, no schema changes).
**Validation**: `npm run check` exits 0 on the reverted state.

## 10. Risks / Notes

[RISK-001](#10-risks--notes): The `TaskOrchestrator` stub needed in TASK-002 — if any dist-runtime test call triggers task creation, a no-op stub will cause a failure. Mitigation: import `TaskOrchestrator` from `dist/tasks.js` instead of stubbing; add an `access()` guard for that file (matching the existing guard pattern on line 41).
[NOTE-001](#10-risks--notes): TASK-003 changes the timing of path validation in `deleteSinglePath` — the `isAllowedRoot` check at line 160 now runs on the validated (resolved) path, not the raw input. Verify there are no tests that pass a raw relative path expecting it to reach the `isAllowedRoot` guard.
