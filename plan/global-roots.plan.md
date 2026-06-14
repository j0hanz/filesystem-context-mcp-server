# global-roots

Spec: [global-roots.specs.md](global-roots.specs.md)

## Goal

Enable `filesystem-mcp` to work fully when installed globally across multiple workspaces
without per-project configuration, supporting both roots-protocol clients and legacy
clients via elicitation.

---

## PHASE-001: Tier 1 — FS_ALLOWED_DIRS + messaging

### TASK-001: Add parseEnvDirList helper to primitives

Depends on: none
Files: [src/core/primitives.ts](../src/core/primitives.ts)
Symbols: [parseTrueEnvFlag](../src/core/primitives.ts#L14)
Satisfies: REQ-001, PERF-001
Action: Add a `parseEnvDirList(envVar: string): string[]` function to `src/core/primitives.ts` that reads the named env var, splits on `:` (POSIX) or `;` (Windows) using `process.platform`, trims each token, and returns non-empty tokens. Keep it pure — no fs calls.
Validate: `node --test --import tsx "__tests__/unit/env-allowed-dirs.test.ts"`
Expected result: New unit test file passes; function correctly splits both separators and drops empty tokens.

### TASK-002: Wire FS_ALLOWED_DIRS into PathGuard baseline

Depends on: [TASK-001](#task-001-add-parseenvdirlist-helper-to-primitives)
Files: [src/core/path.ts](../src/core/path.ts)
Symbols: [PathGuard](../src/core/path.ts#L469), [recomputeAllowedDirectories](../src/core/path.ts#L873), [normalizePath](../src/core/path.ts#L142), [filterRootsWithinBaseline](../src/core/path.ts#L61)
Satisfies: REQ-001, REQ-002, SEC-001
Action: In `PathGuard.recomputeAllowedDirectories()`, call `parseEnvDirList('FS_ALLOWED_DIRS')`, run each token through `normalizePath` then `stat` to verify it is a directory, emit a `logToSender` warning and drop any invalid entries, then merge the valid entries into `cliAllowedDirs` before computing the baseline. The merged entries MUST pass through `resolveAllowedDirectoriesState` (symlink expansion) identically to CLI dirs.
Validate: `node --test --import tsx "__tests__/unit/env-allowed-dirs.test.ts"`
Expected result: Tests confirm allowed dirs from env var are accessible, invalid paths are dropped with a warning, and real paths behind symlinks are correctly expanded.

### TASK-003: Write unit tests for FS_ALLOWED_DIRS

Depends on: [TASK-002](#task-002-wire-fs_allowed_dirs-into-pathguard-baseline)
Files: [**tests**/unit/env-allowed-dirs.test.ts](../__tests__/unit/env-allowed-dirs.test.ts)
Symbols: [PathGuard](../src/core/path.ts#L469)
Satisfies: REQ-002, AC-001, VAL-001
Action: Create `__tests__/unit/env-allowed-dirs.test.ts` covering: (a) valid paths allowed, (b) paths outside env dirs denied, (c) nonexistent path in env var dropped with warning, (d) colon vs semicolon splitting per platform, (e) symlink inside env dir resolves correctly.
Validate: `node --test --import tsx "__tests__/unit/env-allowed-dirs.test.ts"`
Expected result: All 5 test cases pass.

### TASK-004: Enhance empty-state warning with all three root sources

Depends on: [TASK-002](#task-002-wire-fs_allowed_dirs-into-pathguard-baseline)
Files: [src/core/registrar.ts](../src/core/registrar.ts)
Symbols: [logMissingDirectories](../src/core/registrar.ts#L161), [McpRootsSynchronizer](../src/core/registrar.ts#L195)
Satisfies: REQ-003, AC-002, VAL-002
Action: Update `logMissingDirectories` in `src/core/registrar.ts` to emit a warning that explicitly names all three configuration sources: CLI positional args, the `FS_ALLOWED_DIRS` env var, and the MCP Roots protocol (`notifications/roots/list_changed`), plus `--allow-cwd`. Also update the `list_roots` tool description in `src/tools/roots.ts` to reference the same three sources when no roots are configured.
Validate: `node --test --import tsx "__tests__/unit/empty-state-warning.test.ts"`
Expected result: New test confirms warning text contains all three source names; `list_roots` returns an informative message when allowed list is empty.

### TASK-005: Reframe README global-install docs

Depends on: [TASK-002](#task-002-wire-fs_allowed_dirs-into-pathguard-baseline)
Files: [README.md](../README.md)
Symbols: none
Satisfies: REQ-004
Action: Restructure the README configuration section so that: (1) the no-args pattern with MCP roots (`${workspaceFolder}` substitution) is the primary VS Code / Cursor / Claude Code recipe, (2) `FS_ALLOWED_DIRS` is shown as the fallback recipe for clients without roots support (e.g. Claude Desktop), (3) per-project positional args remain documented under "Advanced / per-project". Add `FS_ALLOWED_DIRS` to the CLI reference table and the environment-variables section.
Validate: `node scripts/tasks.mjs --quick`
Expected result: Lint, type-check, and format checks pass (`--quick` runs static checks only per AGENTS.md); README renders the global recipe first.

---

## PHASE-002: Tier 2 — FS_ROOT_BOUNDARY + cwd guards

### TASK-006: Implement FS_ROOT_BOUNDARY boundary filter

Depends on: [TASK-002](#task-002-wire-fs_allowed_dirs-into-pathguard-baseline)
Files: [src/core/path.ts](../src/core/path.ts)
Symbols: [PathGuard](../src/core/path.ts#L469), [recomputeAllowedDirectories](../src/core/path.ts#L873), [filterRootsWithinBaseline](../src/core/path.ts#L61)
Satisfies: REQ-005, REQ-006a, REQ-006b, SEC-001b
Action: Parse `FS_ROOT_BOUNDARY` via `parseEnvDirList`, normalise and validate each boundary entry (stat + symlink-expand via `realpath`), drop invalid entries with warnings. Store boundary as a private field on `PathGuard`. In `recomputeAllowedDirectories`, when boundary is non-empty, replace the `filterRootsWithinBaseline` call to pass the boundary entries as the allowed ceiling (instead of the full baseline), so only client roots whose real path falls inside a boundary entry are admitted. Boundary entries themselves MUST NOT be added to `allowedDirectoriesState`. Update the empty-state warning to say "boundary configured but no roots granted yet" when boundary is set.
Validate: `node --test --import tsx "__tests__/unit/root-boundary.test.ts"`
Expected result: Client root inside boundary → granted; client root outside boundary → filtered; boundary entries themselves do not appear in `list_roots`.

### TASK-007: Write unit tests for FS_ROOT_BOUNDARY

Depends on: [TASK-006](#task-006-implement-fs_root_boundary-boundary-filter)
Files: [**tests**/unit/root-boundary.test.ts](../__tests__/unit/root-boundary.test.ts)
Symbols: [PathGuard](../src/core/path.ts#L469)
Satisfies: REQ-006a, REQ-006b, AC-003, VAL-003
Action: Create `__tests__/unit/root-boundary.test.ts` covering: (a) root inside boundary is granted, (b) root outside boundary is filtered, (c) boundary entry itself is not in `getAllowedDirectories()`, (d) empty-state warning names boundary when set with no roots, (e) symlinked root that resolves inside boundary is granted, (f) symlinked root resolving outside boundary is filtered.
Validate: `node --test --import tsx "__tests__/unit/root-boundary.test.ts"`
Expected result: All 6 test cases pass.

### TASK-008: Add cwd safety guard to --allow-cwd

Depends on: [TASK-002](#task-002-wire-fs_allowed_dirs-into-pathguard-baseline)
Files: [src/core/path.ts](../src/core/path.ts)
Symbols: [PathGuard](../src/core/path.ts#L469), [recomputeAllowedDirectories](../src/core/path.ts#L873), [normalizePath](../src/core/path.ts#L142)
Satisfies: REQ-007, SEC-004
Action: In `PathGuard.recomputeAllowedDirectories()`, before adding `process.cwd()` for `--allow-cwd`, check whether the resolved cwd equals a filesystem root (`parse(cwd).root`), `os.homedir()`, or any entry in a hard-coded `UNSAFE_CWD_PATHS` set (`/usr`, `/etc`, `/bin`, `/sbin`, `/System`, `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`). If matched, emit a `logToSender` warning and skip adding the cwd. Extract the check into a pure `isUnsafeCwdPath(normalizedCwd: string): boolean` function in `src/core/path.ts` for testability.
Validate: `node --test --import tsx "__tests__/unit/allow-cwd-guard.test.ts"`
Expected result: Tests confirm cwd is not added when it is `/`, `$HOME`, or a system dir; warning is emitted; cwd IS added for a normal project directory.

### TASK-009: Write unit tests for --allow-cwd safety guard

Depends on: [TASK-008](#task-008-add-cwd-safety-guard-to---allow-cwd)
Files: [**tests**/unit/allow-cwd-guard.test.ts](../__tests__/unit/allow-cwd-guard.test.ts)
Symbols: none
Satisfies: REQ-007, AC-004, VAL-004
Action: Create `__tests__/unit/allow-cwd-guard.test.ts` covering: (a) `/` rejected, (b) `os.homedir()` rejected, (c) `C:\Windows` rejected (skip on non-Windows), (d) `/usr` rejected, (e) `/home/user/projects/myapp` accepted, (f) warning emitted on rejection, (g) server continues normally after rejection.
Validate: `node --test --import tsx "__tests__/unit/allow-cwd-guard.test.ts"`
Expected result: All cases pass.

### TASK-010: Implement FS_ALLOW_CWD_WALK ancestor walk

Depends on: [TASK-008](#task-008-add-cwd-safety-guard-to---allow-cwd)
Files: [src/core/path.ts](../src/core/path.ts)
Symbols: [PathGuard](../src/core/path.ts#L469), [recomputeAllowedDirectories](../src/core/path.ts#L873)
Satisfies: REQ-008, SEC-004
Action: Add a `findProjectRoot(startDir: string, ceiling: string[]): Promise<string>` function in `src/core/path.ts` that walks ancestor directories from `startDir`, at each level checks for `.git`, `package.json`, or `pyproject.toml` via `stat`, stops at the first match and returns that directory. The walk MUST NOT cross outside any `ceiling` entry (boundary dirs + `os.homedir()`); if no marker is found before the ceiling, return `startDir`. In `recomputeAllowedDirectories`, when `FS_ALLOW_CWD_WALK=1` (via `parseTrueEnvFlag`), replace the raw cwd with `await findProjectRoot(cwd, boundaries)` before adding it to the baseline.
Validate: `node --test --import tsx "__tests__/unit/cwd-walk.test.ts"`
Expected result: Walk from `src/` subdirectory finds the `.git` root; walk from a directory with no marker falls back to start dir; walk does not cross home boundary.

### TASK-011: Write unit tests for FS_ALLOW_CWD_WALK

Depends on: [TASK-010](#task-010-implement-fs_allow_cwd_walk-ancestor-walk)
Files: [**tests**/unit/cwd-walk.test.ts](../__tests__/unit/cwd-walk.test.ts)
Symbols: none
Satisfies: REQ-008, AC-005, VAL-005
Action: Create `__tests__/unit/cwd-walk.test.ts` using tmp directories with synthetic `.git` and `package.json` markers, covering: (a) walk finds `.git` ancestor, (b) walk finds `package.json` ancestor, (c) walk falls back when no marker, (d) walk stops at home dir boundary, (e) walk stops at `FS_ROOT_BOUNDARY` ceiling.
Validate: `node --test --import tsx "__tests__/unit/cwd-walk.test.ts"`
Expected result: All 5 cases pass.

---

## PHASE-003: Tier 3 — Elicitation-based runtime root grants

### TASK-012: Implement request_access tool

Depends on: [TASK-002](#task-002-wire-fs_allowed_dirs-into-pathguard-baseline)
Files: [src/tools/request-access.ts](../src/tools/request-access.ts), [src/core/path.ts](../src/core/path.ts)
Symbols: [PathGuard](../src/core/path.ts#L469), [normalizePath](../src/core/path.ts#L142)
Satisfies: REQ-009, REQ-010, REQ-011a, REQ-011b, SEC-002, SEC-003
Action: Create `src/tools/request-access.ts` using `defineTool`. Input schema: `{ path: z.string() }`. In `run`: (1) check `ctx.server.server.getClientCapabilities()?.elicitation` — if absent, throw `FsError(ErrorCode.ACCESS_DENIED, 'Client does not support elicitation')`. (2) Normalise and stat the path; throw `INVALID_INPUT` if not a directory. (3) Check session denial cache (a `Map<string, boolean>` stored on `ctx`); return cached denial if found. (4) Send elicitation prompt: `ctx.server.server.elicit(...)` with message `"Grant filesystem access to: {resolvedPath}?"`. (5) On approval: if `FS_ROOT_BOUNDARY` is set, verify path falls within boundary; throw `ACCESS_DENIED` with message "Path approved by user but outside configured boundary" if not. Otherwise call `ctx.pathGuard.setRoots([...existing, resolvedPath])`; return `{ ok: true, granted: resolvedPath }`. (6) On denial: cache the denial; return `{ ok: false, reason: '...' }`. This order (elicitation before boundary check) follows SEC-002's "rejected even after user approval" wording.
Validate: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`
Expected result: Tool file created; existing elicitation tests still pass.

### TASK-013: Register request_access and wire denial cache cleanup

Depends on: [TASK-012](#task-012-implement-request_access-tool)
Files: [src/tools/index.ts](../src/tools/index.ts), [src/server.ts](../src/server.ts)
Symbols: [toolsRegistrar](../src/tools/index.ts#L30)
Satisfies: REQ-009, REQ-011b, CON-003
Action: Import and add `REQUEST_ACCESS` to the tool list in `src/tools/index.ts`. In `FilesystemServerContext.disposeRuntimeState()` in `src/server.ts`, clear the session denial cache. Ensure `GuardedFileSystem` in `src/core/fs.ts` exposes whatever accessor `request_access` needs to call `pathGuard.setRoots`. The file `__tests__/unit/tool-registration.test.ts` already exists — extend it with a case asserting `request_access` is present in the registered tool names.
Validate: `node --test --import tsx "__tests__/unit/tool-registration.test.ts"`
Expected result: Existing tool-registration tests still pass; new `request_access` assertion passes.

### TASK-014: Write elicitation integration tests

Depends on: [TASK-013](#task-013-register-request_access-and-wire-denial-cache-cleanup)
Files: [**tests**/tools/elicitation.test.ts](../__tests__/tools/elicitation.test.ts)
Symbols: none
Satisfies: REQ-010, REQ-011a, REQ-011b, SEC-002, SEC-003, AC-006, AC-007, VAL-006, VAL-007
Action: Extend `__tests__/tools/elicitation.test.ts` with cases for `request_access`: (a) elicitation-capable client + user approves → path added to allowed dirs, read on file inside succeeds; (b) elicitation-capable client + user denies → `ok: false`; (c) same path denied twice → second call returns cached denial, elicitation not sent again; (d) client without elicitation capability → `ACCESS_DENIED` error, server does not crash; (e) `FS_ROOT_BOUNDARY` set, user approves path outside boundary → `ACCESS_DENIED`.
Validate: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`
Expected result: All 5 new cases pass alongside existing elicitation tests.

---

## PHASE-END: Acceptance

### TASK-015: Final regression and acceptance verification

Depends on: [TASK-003](#task-003-write-unit-tests-for-fs_allowed_dirs), [TASK-004](#task-004-enhance-empty-state-warning-with-all-three-root-sources), [TASK-007](#task-007-write-unit-tests-for-fs_root_boundary), [TASK-009](#task-009-write-unit-tests-for---allow-cwd-safety-guard), [TASK-011](#task-011-write-unit-tests-for-fs_allow_cwd_walk), [TASK-014](#task-014-write-elicitation-integration-tests)
Files: none
Symbols: none
Satisfies: CON-001, CON-002, CON-004, CON-005, AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007, AC-008
Action: Run the full task suite (`node scripts/tasks.mjs`) to confirm no regressions in existing tests. Manually verify each AC from the spec: AC-001 (FS_ALLOWED_DIRS scopes access), AC-002 (empty-state warning names all sources), AC-003 (FS_ROOT_BOUNDARY filters roots), AC-004 (--allow-cwd blocked on home/root), AC-005 (FS_ALLOW_CWD_WALK finds project root), AC-006 (elicitation approval grants access), AC-007 (no-elicitation client gets ACCESS_DENIED), AC-008 (all existing tests still pass).
Validate: `node scripts/tasks.mjs`
Expected result: All tests pass. No new lint or type errors. Completion signal from spec is met.
