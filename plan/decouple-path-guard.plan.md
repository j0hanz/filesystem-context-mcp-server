# decouple-path-guard

Spec: [decouple-path-guard.specs.md](decouple-path-guard.specs.md)

## Goal

- Decouple PathGuard from MCP Server Roots to separate filesystem domain validation from transport protocol lifecycles
- Completion signal: Full test suite passes and `src/core/path.ts` has zero imports of `@modelcontextprotocol/server`.

## PHASE-001: Scaffolding and Implementation (Coexistence)

### TASK-001: Implement REQ-008

Depends on: none
Files: [src/core/path.ts](src/core/path.ts), [src/core/registrar.ts](src/core/registrar.ts)
Symbols: [resolveRootDirectories](src/core/path.ts#L64)
Satisfies: REQ-008
Action: Relocate the helper functions `resolveRootDirectories`, `resolveRootDirectory`, `getValidRootDirectories`, and `isFileRoot` from `src/core/path.ts` to `src/core/registrar.ts`. Do not remove references from `PathGuard` yet to preserve compilation.
Validate: `npm run type-check`
Expected result: Helper functions compile successfully in `src/core/registrar.ts`.

### TASK-002: Implement REQ-009

Depends on: TASK-001
Files: [src/core/path.ts](src/core/path.ts), [src/core/registrar.ts](src/core/registrar.ts)
Symbols: [logMissingDirectoriesIfNeeded](src/core/path.ts#L804)
Satisfies: REQ-009
Action: Relocate the directory warning logging logic (`logMissingDirectoriesIfNeeded` and `logMissingDirectories`) from `src/core/path.ts` to `src/core/registrar.ts`. Keep temporary delegate methods in `PathGuard` so current call sites in transport still compile.
Validate: `npm run type-check`
Expected result: Directory warning logging logic compiles successfully.

### TASK-003: Implement REQ-003

Depends on: TASK-002
Files: [src/core/registrar.ts](src/core/registrar.ts)
Symbols: none
Satisfies: REQ-003, REQ-004
Action: Define the `McpRootsSynchronizer` class inside `src/core/registrar.ts`. Implement notification registrations for initialized and roots list_changed events.
Validate: `npm run type-check`
Expected result: `McpRootsSynchronizer` compiles with event handler skeleton.

### TASK-004: Implement REQ-005

Depends on: TASK-003
Files: [src/core/registrar.ts](src/core/registrar.ts)
Symbols: none
Satisfies: REQ-005, REQ-006
Action: Implement client roots list querying and handshake timeout timer logic inside `McpRootsSynchronizer`.
Validate: `npm run type-check`
Expected result: `McpRootsSynchronizer` compiles with roots fetching and timeout checking.

### TASK-005: Implement REQ-007

Depends on: TASK-004
Files: [src/core/registrar.ts](src/core/registrar.ts)
Symbols: none
Satisfies: REQ-007
Action: Implement the `destroy()` method inside `McpRootsSynchronizer` to clear `initTimer` and cancel the debounced update wrapper.
Validate: `npm run type-check`
Expected result: Cleanup methods compile successfully.

### TASK-006: Implement REQ-002

Depends on: TASK-005
Files: [src/core/path.ts](src/core/path.ts)
Symbols: [PathGuard](src/core/path.ts#L515)
Satisfies: REQ-002
Action: Implement `setRoots(resolvedRoots: readonly string[]): Promise<void>` in `PathGuard` to update active directories.
Validate: `npm run type-check`
Expected result: `PathGuard` compiles and exports `setRoots`.

## PHASE-002: Integration and Test Migration (Cutting Over)

### TASK-007: Modify FilesystemServerContext in src/server.ts

Depends on: TASK-006
Files: [src/server.ts](src/server.ts)
Symbols: none
Satisfies: AC-005
Action: Update `FilesystemServerContext` to instantiate `McpRootsSynchronizer` alongside `PathGuard`. Wire up `synchronizer.destroy()` call in `disposeRuntimeState()`.
Validate: `npm run type-check`
Expected result: Server context modifications compile successfully.

### TASK-008: Refactor transport.ts call sites

Depends on: TASK-007
Files: [src/transport.ts](src/transport.ts)
Symbols: [startServer](src/transport.ts#L149)
Satisfies: AC-003
Action: Replace all `pathGuard.registerHandlers` and `pathGuard.logMissingDirectoriesIfNeeded` calls in `src/transport.ts` with calls on the synchronizer.
Validate: `npm run type-check`
Expected result: Stdio and HTTP transport server startups compile without error.

### TASK-009: Migrate roots unit tests

Depends on: TASK-008
Files: [**tests**/unit/path-guard-roots.test.ts](__tests__/unit/path-guard-roots.test.ts)
Symbols: none
Satisfies: AC-006
Action: Migrate `__tests__/unit/path-guard-roots.test.ts` to instantiate and test `McpRootsSynchronizer` instead of `PathGuard`.
Validate: `npm test -- __tests__/unit/path-guard-roots.test.ts`
Expected result: Unit tests for synchronized roots run and pass.

### TASK-010: Verify whole test suite behavior

Depends on: TASK-009
Files: none
Symbols: none
Satisfies: AC-001, AC-004
Action: Run full checks and tests to verify that the refactored code has identical behavior.
Validate: `npm test`
Expected result: All unit, integration, and contract tests pass.

## PHASE-003: Deprecation and Cleanup (Contracting)

### TASK-011: Remove SDK references from PathGuard

Depends on: TASK-010
Files: [src/core/path.ts](src/core/path.ts)
Symbols: [PathGuard](src/core/path.ts#L515)
Satisfies: REQ-001, AC-002
Action: Delete unused, deprecated roots methods and remove the `@modelcontextprotocol/server` import from `src/core/path.ts`.
Validate: `npm test`
Expected result: Core tests pass and `path.ts` has zero references to the server package.
