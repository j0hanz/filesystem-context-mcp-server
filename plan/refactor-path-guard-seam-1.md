---
goal: Promote PathGuard to the trusted-path seam by injecting it through HandlerContext, retire src/lib/paths.ts and its AsyncLocalStorage shim, and drop the test-time module-state reset ritual.
version: 1
date_created: 2026-05-08
status: Planned
plan_type: refactor
component: path-guard-seam
---

# Implementation Plan: Deepen PathGuard, retire paths.ts facade

## 1. Goal

Make [PathGuard](src/lib/path-guard.ts#L261) the only seam for path-trust enforcement. Every tool and library helper that currently reads ambient state through [src/lib/paths.ts](src/lib/paths.ts) will receive a `PathGuard` instance through [HandlerContext](src/tools/shared.ts#L434). The AsyncLocalStorage shim, the module-level default guard, and the `setAllowedDirectoriesResolved` test-reset pattern all disappear. Success is observed when [src/lib/paths.ts](src/lib/paths.ts) no longer exists, no production or test code calls `setDefaultPathGuard` / `withPathGuard` / `getAllowedDirectories` (free function), and `node scripts/tasks.mjs` is green.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                                 |
| :---------------------------------------: | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | [HandlerContext](src/tools/shared.ts#L434) gains a required `pathGuard: PathGuard` field; every tool's `run` callback uses `ctx.pathGuard`.                                               |
| [`REQ-002`](#2-requirements--constraints) | Requirement | [src/lib/paths.ts](src/lib/paths.ts) is deleted; its only surviving exports (pure helpers) are imported directly from [src/lib/path-guard.ts](src/lib/path-guard.ts).                     |
| [`REQ-003`](#2-requirements--constraints) | Requirement | [setDefaultPathGuard](src/lib/path-guard.ts#L234), [getDefaultPathGuard](src/lib/path-guard.ts#L238), and the `pathGuardContext` AsyncLocalStorage are removed.                           |
| [`REQ-004`](#2-requirements--constraints) | Requirement | A `PathGuard.fromAllowedDirectories(dirs, signal)` static factory replaces [setAllowedDirectoriesResolved](src/lib/paths.ts#L200).                                                        |
| [`REQ-005`](#2-requirements--constraints) | Requirement | The `FS_CONTEXT_ALLOW_SENSITIVE` env override is read inside [PathGuard](src/lib/path-guard.ts#L261) construction, not at call sites.                                                     |
| [`REQ-006`](#2-requirements--constraints) | Requirement | [readFile](src/lib/file-content.ts#L873) and [calculateFileContentHash](src/lib/file-content.ts#L109) take `pathGuard` as a required parameter.                                           |
| [`REQ-007`](#2-requirements--constraints) | Requirement | [src/lib/path-completer.ts](src/lib/path-completer.ts) public functions take `pathGuard` as a parameter; no ambient lookups remain.                                                       |
| [`CON-001`](#2-requirements--constraints) | Constraint  | No new files in `src/lib/`. All deepening lives inside [src/lib/path-guard.ts](src/lib/path-guard.ts).                                                                                    |
| [`CON-002`](#2-requirements--constraints) | Constraint  | [isPathWithinDirectories](src/lib/path-guard.ts#L129) stays a pure free function — used by [src/server/roots-manager.ts](src/server/roots-manager.ts) against local arrays.               |
| [`CON-003`](#2-requirements--constraints) | Constraint  | All 18 registered tools must continue to pass [contract.test.ts](__tests__/contract.test.ts).                                                                                             |
| [`CON-004`](#2-requirements--constraints) | Constraint  | HTTP per-session isolation must remain: each session's [PathGuard](src/lib/path-guard.ts#L261) is owned by its `RootsManager` and reaches tools only through `ToolRegistrationOptions`.   |
| [`SEC-001`](#2-requirements--constraints) | Security    | Trust-boundary checks (sensitive denylist, allowed-root containment, symlink resolution) must remain identical in semantics; only the call shape changes.                                 |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [defineTool](src/tools/define-tool.ts#L53) construction of [HandlerContext](src/tools/shared.ts#L434) — extend it to read `options.pathGuard` and place it on the handler context. |

## 3. Current Context

### Relevant files

| File                                                                         | Why it matters                                                                                                                                                                  |
| :--------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/lib/paths.ts](src/lib/paths.ts)                                         | Hosts the ALS shim and free-function wrappers that this plan retires.                                                                                                           |
| [src/lib/path-guard.ts](src/lib/path-guard.ts)                               | Owns the trusted-path class; will absorb resolver pipeline and Windows helpers from `paths.ts`.                                                                                 |
| [src/lib/file-content.ts](src/lib/file-content.ts)                           | Calls path validators internally; biggest signature-change site outside of tools.                                                                                               |
| [src/lib/path-completer.ts](src/lib/path-completer.ts)                       | Reads `getAllowedDirectories()` and `isPathWithinDirectories()` ambient.                                                                                                        |
| [src/lib/fs-walk.ts](src/lib/fs-walk.ts)                                     | Already takes a `deps` object with `isPathWithinDirectories` / `isSensitivePath` — call sites must build deps from injected guard.                                              |
| [src/server/bootstrap.ts](src/server/bootstrap.ts)                           | Creates one `McpServer` per HTTP session and currently wraps tool calls with `withPathGuard`.                                                                                   |
| [src/server/roots-manager.ts](src/server/roots-manager.ts)                   | Already owns a per-session `PathGuard`; this becomes the single source for `ToolRegistrationOptions.pathGuard`.                                                                 |
| [src/index.ts](src/index.ts)                                                 | Calls `setAllowedDirectoriesResolved` for stdio bootstrap; replaced with explicit guard construction + injection.                                                               |
| [src/tools/shared.ts](src/tools/shared.ts)                                   | Defines [HandlerContext](src/tools/shared.ts#L434), [ToolRegistrationOptions](src/tools/shared.ts#L477), and the ambient-reading [resolvePathOrRoot](src/tools/shared.ts#L619). |
| [src/tools/define-tool.ts](src/tools/define-tool.ts)                         | Builds [HandlerContext](src/tools/shared.ts#L434) inside [defineTool](src/tools/define-tool.ts#L53) — primary wiring point.                                                     |
| [src/tools/tool-execution.ts](src/tools/tool-execution.ts)                   | Houses [registerStandardTool](src/tools/tool-execution.ts#L1021); receives `ToolRegistrationOptions`.                                                                           |
| [src/tools/apply-patch.ts](src/tools/apply-patch.ts)                         | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/calculate-hash.ts](src/tools/calculate-hash.ts)                   | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/create-directory.ts](src/tools/create-directory.ts)               | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/delete-file.ts](src/tools/delete-file.ts)                         | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/diff-files.ts](src/tools/diff-files.ts)                           | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/edit-file.ts](src/tools/edit-file.ts)                             | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/list-directory.ts](src/tools/list-directory.ts)                   | Tool that imports validators from `paths.ts`; also passes them as `fs-walk` deps.                                                                                               |
| [src/tools/move-file.ts](src/tools/move-file.ts)                             | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/read.ts](src/tools/read.ts)                                       | Tool that calls into [readFile](src/lib/file-content.ts#L873).                                                                                                                  |
| [src/tools/read-multiple.ts](src/tools/read-multiple.ts)                     | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts)               | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/roots.ts](src/tools/roots.ts)                                     | Tool that calls `getAllowedDirectories()` directly.                                                                                                                             |
| [src/tools/search-content.ts](src/tools/search-content.ts)                   | Tool that imports validators from `paths.ts` and passes them as `fs-walk` deps.                                                                                                 |
| [src/tools/search-files.ts](src/tools/search-files.ts)                       | Tool that imports validators from `paths.ts` and passes them as `fs-walk` deps.                                                                                                 |
| [src/tools/stat.ts](src/tools/stat.ts)                                       | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/stat-many.ts](src/tools/stat-many.ts)                             | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [src/tools/tree.ts](src/tools/tree.ts)                                       | Tool that imports validators from `paths.ts` and passes them as `fs-walk` deps.                                                                                                 |
| [src/tools/write-file.ts](src/tools/write-file.ts)                           | Tool that imports validators from `paths.ts`.                                                                                                                                   |
| [**tests**/helpers.ts](__tests__/helpers.ts)                                 | Test bootstrap; calls `setDefaultPathGuard` twice. Will own the new injection-via-options pattern for tests.                                                                    |
| [**tests**/unit/paths-context.test.ts](__tests__/unit/paths-context.test.ts) | Tests the ALS shim that will be removed; the file itself is deleted.                                                                                                            |
| [**tests**/unit/completions.test.ts](__tests__/unit/completions.test.ts)     | Calls `setAllowedDirectoriesResolved` directly; signatures change to pass guard explicitly.                                                                                     |
| [**tests**/unit/path-guard.test.ts](__tests__/unit/path-guard.test.ts)       | Already constructs `PathGuard` directly; survives unchanged or with minor additions.                                                                                            |

### Relevant symbols

| Symbol                                                    | Why it matters                                                                                        |
| :-------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| [PathGuard](src/lib/path-guard.ts#L261)                   | Class that becomes the seam.                                                                          |
| [setDefaultPathGuard](src/lib/path-guard.ts#L234)         | Module-state setter; deleted.                                                                         |
| [getDefaultPathGuard](src/lib/path-guard.ts#L238)         | Module-state reader; deleted.                                                                         |
| [withPathGuard](src/lib/paths.ts#L44)                     | ALS scope helper; deleted.                                                                            |
| [withAllowedDirectoriesState](src/lib/paths.ts#L53)       | ALS scope helper; deleted.                                                                            |
| [getActivePathGuard](src/lib/paths.ts#L62)                | Internal ALS reader; deleted.                                                                         |
| [getAllowedDirectories](src/lib/paths.ts#L68)             | Free wrapper; deleted (becomes method on `PathGuard`).                                                |
| [isAllowedDirectoryRoot](src/lib/paths.ts#L72)            | Free wrapper; folded into `PathGuard`.                                                                |
| [isSensitivePath](src/lib/paths.ts#L81)                   | Free wrapper; deleted (callers use `pathGuard.isSensitive`).                                          |
| [assertAllowedFileAccess](src/lib/paths.ts#L88)           | Free wrapper; folded into `PathGuard.assertAllowedFileAccess`.                                        |
| [validateExistingPath](src/lib/paths.ts#L104)             | Free wrapper; deleted.                                                                                |
| [validateExistingPathDetailed](src/lib/paths.ts#L112)     | Free wrapper; deleted.                                                                                |
| [validateExistingDirectory](src/lib/paths.ts#L120)        | Free wrapper; deleted.                                                                                |
| [validatePathForWrite](src/lib/paths.ts#L128)             | Free wrapper; deleted.                                                                                |
| [resolveAllowedDirectoriesState](src/lib/paths.ts#L191)   | Resolver pipeline; moves into [src/lib/path-guard.ts](src/lib/path-guard.ts).                         |
| [setAllowedDirectoriesResolved](src/lib/paths.ts#L200)    | Replaced by `PathGuard.fromAllowedDirectories` static factory.                                        |
| [getReservedDeviceNameForPath](src/lib/paths.ts#L262)     | Pure Windows helper; moves into [src/lib/path-guard.ts](src/lib/path-guard.ts).                       |
| [isWindowsDriveRelativePath](src/lib/paths.ts#L276)       | Pure Windows helper; moves into [src/lib/path-guard.ts](src/lib/path-guard.ts).                       |
| [HandlerContext](src/tools/shared.ts#L434)                | Gains a required `pathGuard` field.                                                                   |
| [ToolRegistrationOptions](src/tools/shared.ts#L477)       | Already has `pathGuard: PathGuard`; becomes a real producer.                                          |
| [defineTool](src/tools/define-tool.ts#L53)                | Threads `options.pathGuard` into the constructed `HandlerContext`.                                    |
| [registerStandardTool](src/tools/tool-execution.ts#L1021) | Receives `ToolRegistrationOptions`; no behavioral change required, but the field is now load-bearing. |
| [resolvePathOrRoot](src/tools/shared.ts#L619)             | Becomes a method on `PathGuard`.                                                                      |
| [readFile](src/lib/file-content.ts#L873)                  | Signature gains `pathGuard` parameter.                                                                |
| [calculateFileContentHash](src/lib/file-content.ts#L109)  | Overload set gains `pathGuard` parameter.                                                             |
| [createTestEnv](__tests__/helpers.ts#L48)                 | Test factory; constructs `PathGuard` and threads it through `ToolRegistrationOptions`.                |

### Existing commands

```bash
# Full dev loop (preferred)
node scripts/tasks.mjs

# Type-check only
npm run type-check

# Lint
npm run lint

# Tests
npm test

# Build
npm run build
```

### Current behavior

Every path-validating call from a tool or lib helper goes through a free function in [src/lib/paths.ts](src/lib/paths.ts). That free function reads an `AsyncLocalStorage<PathGuard>` (`pathGuardContext`) for the current scope, falling back to a process-global default registered via [setDefaultPathGuard](src/lib/path-guard.ts#L234). HTTP isolation is achieved by wrapping each tool call in [withPathGuard](src/lib/paths.ts#L44) inside [src/server/bootstrap.ts](src/server/bootstrap.ts); stdio uses the global default. Tests reset the global default with [setDefaultPathGuard](src/lib/path-guard.ts#L234) on every `createTestEnv`. The result: the trust boundary is implemented in two files, threaded through ambient state, and tests carry an unrelated reset ritual.

## 4. Implementation Phases

### PHASE-001: Deepen PathGuard

**Goal:** [PathGuard](src/lib/path-guard.ts#L261) becomes the single owner of all path-trust logic, including resolver-pipeline construction, Windows-path helpers, the sensitive-override env flag, and a root-disambiguation method.

|                                         Task                                         | Action                                                                                                         |                                      Depends on                                      | Files                                                                                | Validate             |
| :----------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------- | :------------------- |
| [`TASK-001`](#task-001-fold-resolver-pipeline-and-windows-helpers-into-path-guardts) | Move resolver pipeline and Windows helpers from `paths.ts` into `path-guard.ts`.                               |                                         none                                         | [src/lib/path-guard.ts](src/lib/path-guard.ts); [src/lib/paths.ts](src/lib/paths.ts) | `npm run type-check` |
|      [`TASK-002`](#task-002-add-pathguardfromalloweddirectories-static-factory)      | Add `PathGuard.fromAllowedDirectories(dirs, signal)` and read `FS_CONTEXT_ALLOW_SENSITIVE` in the constructor. | [`TASK-001`](#task-001-fold-resolver-pipeline-and-windows-helpers-into-path-guardts) | [src/lib/path-guard.ts](src/lib/path-guard.ts)                                       | `npm run type-check` |
| [`TASK-003`](#task-003-add-resolvepathorroot-and-isallowedroot-methods-to-pathguard) | Add `resolvePathOrRoot(value?)` and `isAllowedRoot(path)` methods.                                             | [`TASK-001`](#task-001-fold-resolver-pipeline-and-windows-helpers-into-path-guardts) | [src/lib/path-guard.ts](src/lib/path-guard.ts)                                       | `npm run type-check` |

#### TASK-001: Fold resolver pipeline and Windows helpers into path-guard.ts

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                         |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | none                                                                                                                                                                                                                                                                                                                                                                                                          |
| Files           | [src/lib/path-guard.ts](src/lib/path-guard.ts); [src/lib/paths.ts](src/lib/paths.ts)                                                                                                                                                                                                                                                                                                                          |
| Symbols         | [resolveAllowedDirectoriesState](src/lib/paths.ts#L191); [getReservedDeviceNameForPath](src/lib/paths.ts#L262); [isWindowsDriveRelativePath](src/lib/paths.ts#L276)                                                                                                                                                                                                                                           |
| Action          | Cut `resolveAllowedDirectoriesState`, `normalizeAllowedDirectories`, `expandAllowedDirectories`, `getReservedDeviceName`, `getReservedDeviceNameForPath`, and `isWindowsDriveRelativePath` from [src/lib/paths.ts](src/lib/paths.ts). Paste them into [src/lib/path-guard.ts](src/lib/path-guard.ts) as exported functions. Leave `paths.ts` re-exporting them temporarily so downstream code still compiles. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                                                                                                                      |
| Expected result | `tsc --noEmit` reports zero errors; the moved functions are now declared in `path-guard.ts` and re-exported from `paths.ts`.                                                                                                                                                                                                                                                                                  |

#### TASK-002: Add PathGuard.fromAllowedDirectories static factory

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-001`](#task-001-fold-resolver-pipeline-and-windows-helpers-into-path-guardts)                                                                                                                                                                                                                                                                                                                                                                       |
| Files           | [src/lib/path-guard.ts](src/lib/path-guard.ts)                                                                                                                                                                                                                                                                                                                                                                                                             |
| Symbols         | [PathGuard](src/lib/path-guard.ts#L261)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Action          | Add `static async fromAllowedDirectories(dirs: readonly string[], signal?: AbortSignal): Promise<PathGuard>` that calls `resolveAllowedDirectoriesState`, constructs a guard with `SENSITIVE_FILE_DENYLIST` and `parseEnvBool('FS_CONTEXT_ALLOW_SENSITIVE')`, calls `initialize(state)`, and returns it. Rewrite the existing constructor to accept `{ sensitivePatterns, allowSensitive }` and short-circuit `isSensitive` when `allowSensitive` is true. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Expected result | `PathGuard.fromAllowedDirectories([dir])` compiles and returns an initialized guard; the `FS_CONTEXT_ALLOW_SENSITIVE` flag is no longer read by call sites.                                                                                                                                                                                                                                                                                                |

#### TASK-003: Add resolvePathOrRoot and isAllowedRoot methods to PathGuard

| Field           | Value                                                                                                                                                                                                                                                                                            |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-001`](#task-001-fold-resolver-pipeline-and-windows-helpers-into-path-guardts)                                                                                                                                                                                                             |
| Files           | [src/lib/path-guard.ts](src/lib/path-guard.ts)                                                                                                                                                                                                                                                   |
| Symbols         | [PathGuard](src/lib/path-guard.ts#L261); [resolvePathOrRoot](src/tools/shared.ts#L619); [isAllowedDirectoryRoot](src/lib/paths.ts#L72)                                                                                                                                                           |
| Action          | Add `resolvePathOrRoot(value: string \| undefined): string` (logic copied from [resolvePathOrRoot](src/tools/shared.ts#L619)) and `isAllowedRoot(normalizedPath: string): boolean` (logic copied from [isAllowedDirectoryRoot](src/lib/paths.ts#L72)). Both read `this` state, not module state. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                         |
| Expected result | Two new methods exist on `PathGuard` and compile; no callers updated yet.                                                                                                                                                                                                                        |

### PHASE-002: Wire PathGuard through HandlerContext

**Goal:** Every tool's `run` callback receives `pathGuard` on its [HandlerContext](src/tools/shared.ts#L434), produced by [defineTool](src/tools/define-tool.ts#L53) from [ToolRegistrationOptions](src/tools/shared.ts#L477).

|                                           Task                                           | Action                                                                                                                                          |                                      Depends on                                      | Files                                                                                            | Validate             |
| :--------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------- | :------------------- |
| [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool) | Add `pathGuard: PathGuard` to [HandlerContext](src/tools/shared.ts#L434); read it from `options` in [defineTool](src/tools/define-tool.ts#L53). | [`TASK-003`](#task-003-add-resolvepathorroot-and-isallowedroot-methods-to-pathguard) | [src/tools/shared.ts](src/tools/shared.ts); [src/tools/define-tool.ts](src/tools/define-tool.ts) | `npm run type-check` |

#### TASK-004: Add pathGuard to HandlerContext and thread it through defineTool

| Field           | Value                                                                                                                                                                                                                                                                                    |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-003`](#task-003-add-resolvepathorroot-and-isallowedroot-methods-to-pathguard)                                                                                                                                                                                                     |
| Files           | [src/tools/shared.ts](src/tools/shared.ts); [src/tools/define-tool.ts](src/tools/define-tool.ts)                                                                                                                                                                                         |
| Symbols         | [HandlerContext](src/tools/shared.ts#L434); [defineTool](src/tools/define-tool.ts#L53); [ToolRegistrationOptions](src/tools/shared.ts#L477)                                                                                                                                              |
| Action          | Add `pathGuard: PathGuard` (required) to [HandlerContext](src/tools/shared.ts#L434). In [defineTool](src/tools/define-tool.ts#L53)'s `register` body, set `handlerCtx.pathGuard = options.pathGuard` when constructing `HandlerContext`. Import `PathGuard` from `../lib/path-guard.js`. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                 |
| Expected result | `HandlerContext` exposes `pathGuard`; type-check passes (existing tools still compile because they don't yet read the field).                                                                                                                                                            |

### PHASE-003: Migrate tool call sites off paths.ts

**Goal:** Every tool source file imports zero symbols from [src/lib/paths.ts](src/lib/paths.ts). All path-validation calls go through `ctx.pathGuard.<method>(args, ctx.signal)`.

|                                        Task                                        | Action                                                                                                        |                                                                                   Depends on                                                                                   | Files                                                                                                                                                                                                                                                                                                      | Validate             |
| :--------------------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------- |
|                  [`TASK-005`](#task-005-migrate-write-only-tools)                  | Switch write-only tools to `ctx.pathGuard`.                                                                   |                                            [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                            | [src/tools/write-file.ts](src/tools/write-file.ts); [src/tools/create-directory.ts](src/tools/create-directory.ts); [src/tools/delete-file.ts](src/tools/delete-file.ts)                                                                                                                                   | `npm run type-check` |
|                     [`TASK-006`](#task-006-migrate-edit-tools)                     | Switch edit tools to `ctx.pathGuard`.                                                                         |                                            [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                            | [src/tools/edit-file.ts](src/tools/edit-file.ts); [src/tools/apply-patch.ts](src/tools/apply-patch.ts); [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [src/tools/move-file.ts](src/tools/move-file.ts)                                                                                   | `npm run type-check` |
|                [`TASK-007`](#task-007-migrate-read-and-stat-tools)                 | Switch read/stat tools to `ctx.pathGuard`.                                                                    |                                               [`TASK-008`](#task-008-add-pathguard-parameter-to-file-contentts-public-functions)                                               | [src/tools/read.ts](src/tools/read.ts); [src/tools/read-multiple.ts](src/tools/read-multiple.ts); [src/tools/stat.ts](src/tools/stat.ts); [src/tools/stat-many.ts](src/tools/stat-many.ts); [src/tools/calculate-hash.ts](src/tools/calculate-hash.ts); [src/tools/diff-files.ts](src/tools/diff-files.ts) | `npm run type-check` |
| [`TASK-008`](#task-008-add-pathguard-parameter-to-file-contentts-public-functions) | Add `pathGuard` param to `readFile`, `calculateFileContentHash`, and helpers.                                 |                                            [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                            | [src/lib/file-content.ts](src/lib/file-content.ts)                                                                                                                                                                                                                                                         | `npm run type-check` |
|                     [`TASK-009`](#task-009-migrate-walk-tools)                     | Switch list-directory, search-files, search-content, tree to `ctx.pathGuard`.                                 |                                            [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                            | [src/tools/list-directory.ts](src/tools/list-directory.ts); [src/tools/search-files.ts](src/tools/search-files.ts); [src/tools/search-content.ts](src/tools/search-content.ts); [src/tools/tree.ts](src/tools/tree.ts)                                                                                     | `npm run type-check` |
|                     [`TASK-010`](#task-010-migrate-roots-tool)                     | Switch [src/tools/roots.ts](src/tools/roots.ts) to `ctx.pathGuard.getAllowedDirectories()`.                   |                                            [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                            | [src/tools/roots.ts](src/tools/roots.ts)                                                                                                                                                                                                                                                                   | `npm run type-check` |
|             [`TASK-011`](#task-011-migrate-resolvepathorroot-callers)              | Replace [resolvePathOrRoot](src/tools/shared.ts#L619) call sites with `ctx.pathGuard.resolvePathOrRoot(...)`. | [`TASK-003`](#task-003-add-resolvepathorroot-and-isallowedroot-methods-to-pathguard); [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool) | [src/tools/shared.ts](src/tools/shared.ts); call-site files identified by grep                                                                                                                                                                                                                             | `npm run type-check` |

#### TASK-005: Migrate write-only tools

| Field           | Value                                                                                                                                                                                                                                                                                                   |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                                                                                                                                                                                                |
| Files           | [src/tools/write-file.ts](src/tools/write-file.ts); [src/tools/create-directory.ts](src/tools/create-directory.ts); [src/tools/delete-file.ts](src/tools/delete-file.ts)                                                                                                                                |
| Symbols         | [validatePathForWrite](src/lib/paths.ts#L128); [isAllowedDirectoryRoot](src/lib/paths.ts#L72)                                                                                                                                                                                                           |
| Action          | Replace each `validatePathForWrite(p, signal)` import-and-call with `ctx.pathGuard.validatePathForWrite(p, signal)`. Replace [delete-file.ts](src/tools/delete-file.ts)'s `isAllowedDirectoryRoot(...)` with `ctx.pathGuard.isAllowedRoot(...)`. Remove the now-dead `paths.js` imports from each file. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                |
| Expected result | None of the three files import from `../lib/paths.js`; type-check passes.                                                                                                                                                                                                                               |

#### TASK-006: Migrate edit tools

| Field           | Value                                                                                                                                                                                                                                                |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                                                                                                                                             |
| Files           | [src/tools/edit-file.ts](src/tools/edit-file.ts); [src/tools/apply-patch.ts](src/tools/apply-patch.ts); [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [src/tools/move-file.ts](src/tools/move-file.ts)                             |
| Symbols         | [validateExistingPath](src/lib/paths.ts#L104); [validatePathForWrite](src/lib/paths.ts#L128); [assertAllowedFileAccess](src/lib/paths.ts#L88)                                                                                                        |
| Action          | Replace every free-function call with `ctx.pathGuard.<method>(...)`. For helper functions inside these files that don't take `ctx`, change their signatures to accept `pathGuard: PathGuard` and pass it from the caller. Remove `paths.js` imports. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                             |
| Expected result | None of the four files import from `../lib/paths.js`; type-check passes.                                                                                                                                                                             |

#### TASK-007: Migrate read and stat tools

| Field           | Value                                                                                                                                                                                                                                                                                                      |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-008`](#task-008-add-pathguard-parameter-to-file-contentts-public-functions)                                                                                                                                                                                                                         |
| Files           | [src/tools/read.ts](src/tools/read.ts); [src/tools/read-multiple.ts](src/tools/read-multiple.ts); [src/tools/stat.ts](src/tools/stat.ts); [src/tools/stat-many.ts](src/tools/stat-many.ts); [src/tools/calculate-hash.ts](src/tools/calculate-hash.ts); [src/tools/diff-files.ts](src/tools/diff-files.ts) |
| Symbols         | [validateExistingPath](src/lib/paths.ts#L104); [validateExistingPathDetailed](src/lib/paths.ts#L112); [assertAllowedFileAccess](src/lib/paths.ts#L88); [readFile](src/lib/file-content.ts#L873); [calculateFileContentHash](src/lib/file-content.ts#L109)                                                  |
| Action          | Replace free-function calls with `ctx.pathGuard.<method>(...)`. Pass `ctx.pathGuard` to every `readFile` / `calculateFileContentHash` call (signature added in [`TASK-008`](#task-008-add-pathguard-parameter-to-file-contentts-public-functions)). Remove `paths.js` imports.                             |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                   |
| Expected result | None of the six files import from `../lib/paths.js`; type-check passes.                                                                                                                                                                                                                                    |

#### TASK-008: Add pathGuard parameter to file-content.ts public functions

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                                                                                                                                                                                                                                                                                                                                     |
| Files           | [src/lib/file-content.ts](src/lib/file-content.ts)                                                                                                                                                                                                                                                                                                                                                                                           |
| Symbols         | [readFile](src/lib/file-content.ts#L873); [calculateFileContentHash](src/lib/file-content.ts#L109)                                                                                                                                                                                                                                                                                                                                           |
| Action          | Add a required `pathGuard: PathGuard` parameter to [readFile](src/lib/file-content.ts#L873), every overload of [calculateFileContentHash](src/lib/file-content.ts#L109), and any internal helper that calls `validateExistingPath` or `assertAllowedFileAccess`. Replace internal free-function calls with method calls on the parameter. Remove the `import { assertAllowedFileAccess, validateExistingPath } from './paths.js'` statement. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Expected result | `file-content.ts` does not import from `./paths.js`; signatures of the public functions have a new required `pathGuard` parameter.                                                                                                                                                                                                                                                                                                           |

#### TASK-009: Migrate walk tools

| Field           | Value                                                                                                                                                                                                                                                                                                        |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                                                                                                                                                                                                     |
| Files           | [src/tools/list-directory.ts](src/tools/list-directory.ts); [src/tools/search-files.ts](src/tools/search-files.ts); [src/tools/search-content.ts](src/tools/search-content.ts); [src/tools/tree.ts](src/tools/tree.ts)                                                                                       |
| Symbols         | [validateExistingDirectory](src/lib/paths.ts#L120); [validateExistingPathDetailed](src/lib/paths.ts#L112); [isPathWithinDirectories](src/lib/path-guard.ts#L129); [isSensitivePath](src/lib/paths.ts#L81); [assertAllowedFileAccess](src/lib/paths.ts#L88)                                                   |
| Action          | Replace validator imports with `ctx.pathGuard` method calls. For the `fs-walk` `deps` object, build it inline: `{ isPathWithinDirectories, isSensitivePath: (p, r) => ctx.pathGuard.isSensitive(p) }` (still using the pure free `isPathWithinDirectories` from `path-guard.ts`). Remove `paths.js` imports. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                                     |
| Expected result | None of the four files import from `../lib/paths.js`; type-check passes.                                                                                                                                                                                                                                     |

#### TASK-010: Migrate roots tool

| Field           | Value                                                                                                         |
| :-------------- | :------------------------------------------------------------------------------------------------------------ |
| Depends on      | [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                      |
| Files           | [src/tools/roots.ts](src/tools/roots.ts)                                                                      |
| Symbols         | [getAllowedDirectories](src/lib/paths.ts#L68)                                                                 |
| Action          | Replace `getAllowedDirectories()` with `ctx.pathGuard.getAllowedDirectories()`. Remove the `paths.js` import. |
| Validate        | Run `npm run type-check`                                                                                      |
| Expected result | `src/tools/roots.ts` does not import from `../lib/paths.js`; type-check passes.                               |

#### TASK-011: Migrate resolvePathOrRoot callers

| Field           | Value                                                                                                                                                                                                                  |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-003`](#task-003-add-resolvepathorroot-and-isallowedroot-methods-to-pathguard); [`TASK-004`](#task-004-add-pathguard-to-handlercontext-and-thread-it-through-definetool)                                         |
| Files           | [src/tools/shared.ts](src/tools/shared.ts); call sites identified by `grep_search` for `resolvePathOrRoot`                                                                                                             |
| Symbols         | [resolvePathOrRoot](src/tools/shared.ts#L619)                                                                                                                                                                          |
| Action          | Replace each call to the free `resolvePathOrRoot(value)` with `ctx.pathGuard.resolvePathOrRoot(value)`. Delete the free function and its `getAllowedDirectories` import in [src/tools/shared.ts](src/tools/shared.ts). |
| Validate        | Run `npm run type-check`                                                                                                                                                                                               |
| Expected result | The free `resolvePathOrRoot` no longer exists; all call sites compile.                                                                                                                                                 |

### PHASE-004: Migrate library helpers off paths.ts

**Goal:** [src/lib/path-completer.ts](src/lib/path-completer.ts) and [src/lib/fs-walk.ts](src/lib/fs-walk.ts) callers no longer rely on ambient state.

|                               Task                                | Action                                                                |                                 Depends on                                 | Files                                                            | Validate             |
| :---------------------------------------------------------------: | :-------------------------------------------------------------------- | :------------------------------------------------------------------------: | :--------------------------------------------------------------- | :------------------- |
| [`TASK-012`](#task-012-add-pathguard-parameter-to-path-completer) | Add `pathGuard` parameter to public functions in `path-completer.ts`. | [`TASK-002`](#task-002-add-pathguardfromalloweddirectories-static-factory) | [src/lib/path-completer.ts](src/lib/path-completer.ts)           | `npm run type-check` |
|       [`TASK-013`](#task-013-update-path-completer-callers)       | Update every caller of `path-completer.ts` to pass `pathGuard`.       |     [`TASK-012`](#task-012-add-pathguard-parameter-to-path-completer)      | callers identified by `grep_search` for path-completer functions | `npm run type-check` |

#### TASK-012: Add pathGuard parameter to path-completer

| Field           | Value                                                                                                                                                                                                                                                             |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-002`](#task-002-add-pathguardfromalloweddirectories-static-factory)                                                                                                                                                                                        |
| Files           | [src/lib/path-completer.ts](src/lib/path-completer.ts)                                                                                                                                                                                                            |
| Symbols         | [getAllowedDirectories](src/lib/paths.ts#L68); [isPathWithinDirectories](src/lib/path-guard.ts#L129)                                                                                                                                                              |
| Action          | Add a required `pathGuard: PathGuard` parameter to every exported function that currently calls `getAllowedDirectories()`. Replace that call with `pathGuard.getAllowedDirectories()`. Keep `isPathWithinDirectories` as a pure free import from `path-guard.ts`. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                          |
| Expected result | `path-completer.ts` does not import from `./paths.js`; signatures gain a `pathGuard` parameter.                                                                                                                                                                   |

#### TASK-013: Update path-completer callers

| Field           | Value                                                                                                                                                                                                                          |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-012`](#task-012-add-pathguard-parameter-to-path-completer)                                                                                                                                                              |
| Files           | callers identified by `grep_search` for path-completer functions (likely [src/server/bootstrap.ts](src/server/bootstrap.ts) or wherever the MCP completion handler is wired)                                                   |
| Symbols         | path-completer exports                                                                                                                                                                                                         |
| Action          | At each call site, supply the active `PathGuard` (from the session's `RootsManager.pathGuard` for HTTP, or the singleton-scoped guard for stdio) as the new parameter. Remove any `withPathGuard` wrappers around these calls. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                       |
| Expected result | All callers pass an explicit `pathGuard`; type-check passes.                                                                                                                                                                   |

### PHASE-005: Wire bootstrap and index.ts

**Goal:** Stdio constructs a `PathGuard` explicitly via [PathGuard.fromAllowedDirectories](src/lib/path-guard.ts#L261) (`TASK-002`) and threads it through `ToolRegistrationOptions`. HTTP stops calling `withPathGuard` because the guard is already on every tool's context.

|                               Task                               | Action                                                                                                               |                                                    Depends on                                                    | Files                                              | Validate             |
| :--------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------: | :------------------------------------------------- | :------------------- |
|          [`TASK-014`](#task-014-rewire-stdio-bootstrap)          | Replace [setAllowedDirectoriesResolved](src/lib/paths.ts#L200) in `index.ts` with explicit `PathGuard` construction. | [`TASK-013`](#task-013-update-path-completer-callers); [`TASK-011`](#task-011-migrate-resolvepathorroot-callers) | [src/index.ts](src/index.ts)                       | `npm run type-check` |
| [`TASK-015`](#task-015-remove-withpathguard-from-http-bootstrap) | Drop [withPathGuard](src/lib/paths.ts#L44) wrapper in HTTP bootstrap; pass guard via registration options instead.   |                                  [`TASK-014`](#task-014-rewire-stdio-bootstrap)                                  | [src/server/bootstrap.ts](src/server/bootstrap.ts) | `npm run type-check` |

#### TASK-014: Rewire stdio bootstrap

| Field           | Value                                                                                                                                                                                                                                                                                          |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-013`](#task-013-update-path-completer-callers); [`TASK-011`](#task-011-migrate-resolvepathorroot-callers)                                                                                                                                                                               |
| Files           | [src/index.ts](src/index.ts)                                                                                                                                                                                                                                                                   |
| Symbols         | [setAllowedDirectoriesResolved](src/lib/paths.ts#L200)                                                                                                                                                                                                                                         |
| Action          | Replace `await setAllowedDirectoriesResolved(allowedDirs, signal)` with `const pathGuard = await PathGuard.fromAllowedDirectories(allowedDirs, signal)`. Forward `pathGuard` into the stdio `ToolRegistrationOptions` produced for the singleton `RootsManager`. Remove the `paths.js` import. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                                                       |
| Expected result | `index.ts` does not import from `./lib/paths.js`; stdio construction explicitly produces a `PathGuard` and passes it on.                                                                                                                                                                       |

#### TASK-015: Remove withPathGuard from HTTP bootstrap

| Field           | Value                                                                                                                                                                                                                                                         |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | [`TASK-014`](#task-014-rewire-stdio-bootstrap)                                                                                                                                                                                                                |
| Files           | [src/server/bootstrap.ts](src/server/bootstrap.ts)                                                                                                                                                                                                            |
| Symbols         | [withPathGuard](src/lib/paths.ts#L44)                                                                                                                                                                                                                         |
| Action          | Remove the `withPathGuard(session.rootsManager.pathGuard, ...)` wrapper at the request-dispatch site. Confirm `session.rootsManager.pathGuard` is already passed into each session's `ToolRegistrationOptions`; if not, add it. Remove the `paths.js` import. |
| Validate        | Run `npm run type-check`                                                                                                                                                                                                                                      |
| Expected result | `bootstrap.ts` does not import from `../lib/paths.js`; HTTP per-session isolation is achieved purely by per-session `ToolRegistrationOptions.pathGuard`.                                                                                                      |

### PHASE-006: Delete paths.ts and ALS infrastructure

**Goal:** [src/lib/paths.ts](src/lib/paths.ts) is deleted; `setDefaultPathGuard` / `getDefaultPathGuard` / `pathGuardContext` no longer exist anywhere in the codebase.

|                          Task                           | Action                                                                     |                            Depends on                            | Files                                                                                | Validate                             |
| :-----------------------------------------------------: | :------------------------------------------------------------------------- | :--------------------------------------------------------------: | :----------------------------------------------------------------------------------- | :----------------------------------- |
| [`TASK-016`](#task-016-delete-paths-ts-and-als-globals) | Delete `paths.ts`; remove ALS, default-guard exports from `path-guard.ts`. | [`TASK-015`](#task-015-remove-withpathguard-from-http-bootstrap) | [src/lib/paths.ts](src/lib/paths.ts); [src/lib/path-guard.ts](src/lib/path-guard.ts) | `npm run type-check && npm run lint` |

#### TASK-016: Delete paths.ts and ALS globals

| Field           | Value                                                                                                                                                                                                                                                                                |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-015`](#task-015-remove-withpathguard-from-http-bootstrap)                                                                                                                                                                                                                     |
| Files           | [src/lib/paths.ts](src/lib/paths.ts); [src/lib/path-guard.ts](src/lib/path-guard.ts)                                                                                                                                                                                                 |
| Symbols         | [setDefaultPathGuard](src/lib/path-guard.ts#L234); [getDefaultPathGuard](src/lib/path-guard.ts#L238)                                                                                                                                                                                 |
| Action          | Delete the file [src/lib/paths.ts](src/lib/paths.ts). In [src/lib/path-guard.ts](src/lib/path-guard.ts), delete `setDefaultPathGuard`, `getDefaultPathGuard`, and the module-level `defaultPathGuard` variable. Run `grep -r "from .*paths\\.js"` to confirm zero remaining imports. |
| Validate        | Run `npm run type-check && npm run lint`                                                                                                                                                                                                                                             |
| Expected result | Type-check and lint pass with zero references to `paths.js`, `setDefaultPathGuard`, `getDefaultPathGuard`, or `pathGuardContext`.                                                                                                                                                    |

### PHASE-007: Update tests

**Goal:** [createTestEnv](__tests__/helpers.ts#L48) constructs a `PathGuard` via [PathGuard.fromAllowedDirectories](src/lib/path-guard.ts#L261) and threads it through `ToolRegistrationOptions`. The ALS-test file is deleted; the completions test passes the guard explicitly.

|                                    Task                                     | Action                                                                                                    |                       Depends on                        | Files                                                                                                                                                  | Validate   |
| :-------------------------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------- | :-----------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :--------- |
|                [`TASK-017`](#task-017-rewire-createtestenv)                 | Replace `setDefaultPathGuard` calls in [createTestEnv](__tests__/helpers.ts#L48) with explicit injection. | [`TASK-016`](#task-016-delete-paths-ts-and-als-globals) | [**tests**/helpers.ts](__tests__/helpers.ts)                                                                                                           | `npm test` |
| [`TASK-018`](#task-018-delete-pathscontexttest-and-update-completions-test) | Delete the ALS-only test; update the completions test to construct a guard.                               | [`TASK-016`](#task-016-delete-paths-ts-and-als-globals) | [**tests**/unit/paths-context.test.ts](__tests__/unit/paths-context.test.ts); [**tests**/unit/completions.test.ts](__tests__/unit/completions.test.ts) | `npm test` |

#### TASK-017: Rewire createTestEnv

| Field           | Value                                                                                                                                                                                                                      |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-016`](#task-016-delete-paths-ts-and-als-globals)                                                                                                                                                                    |
| Files           | [**tests**/helpers.ts](__tests__/helpers.ts)                                                                                                                                                                               |
| Symbols         | [createTestEnv](__tests__/helpers.ts#L48); [PathGuard](src/lib/path-guard.ts#L261)                                                                                                                                         |
| Action          | Remove every `setDefaultPathGuard(pathGuard)` call. Where the test creates a `PathGuard`, pass it into the constructed `ToolRegistrationOptions` and through to whatever `defineTool`-based registration the test invokes. |
| Validate        | Run `npm test`                                                                                                                                                                                                             |
| Expected result | All non-deleted tests pass; `helpers.ts` does not import `setDefaultPathGuard`.                                                                                                                                            |

#### TASK-018: Delete paths-context test and update completions test

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-016`](#task-016-delete-paths-ts-and-als-globals)                                                                                                                                                                                                                                                                                                                                                                                    |
| Files           | [**tests**/unit/paths-context.test.ts](__tests__/unit/paths-context.test.ts); [**tests**/unit/completions.test.ts](__tests__/unit/completions.test.ts)                                                                                                                                                                                                                                                                                     |
| Symbols         | [setAllowedDirectoriesResolved](src/lib/paths.ts#L200)                                                                                                                                                                                                                                                                                                                                                                                     |
| Action          | Delete [**tests**/unit/paths-context.test.ts](__tests__/unit/paths-context.test.ts) entirely (it tests the ALS shim that no longer exists). In [**tests**/unit/completions.test.ts](__tests__/unit/completions.test.ts), replace each `setAllowedDirectoriesResolved([dir])` call with `const guard = await PathGuard.fromAllowedDirectories([dir])` and pass `guard` as the new explicit parameter to the completer functions under test. |
| Validate        | Run `npm test`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Expected result | `paths-context.test.ts` no longer exists; `completions.test.ts` constructs its own guard and passes it explicitly; all tests pass.                                                                                                                                                                                                                                                                                                         |

### PHASE-008: Final validation

**Goal:** Repository-wide green build with the deepened seam.

|                   Task                    | Action                              |                                 Depends on                                  | Files | Validate                 |
| :---------------------------------------: | :---------------------------------- | :-------------------------------------------------------------------------: | :---- | :----------------------- |
| [`TASK-019`](#task-019-run-full-tasksmjs) | Run the full dev-loop verification. | [`TASK-018`](#task-018-delete-pathscontexttest-and-update-completions-test) | n/a   | `node scripts/tasks.mjs` |

#### TASK-019: Run full tasks.mjs

| Field           | Value                                                                                  |
| :-------------- | :------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-018`](#task-018-delete-pathscontexttest-and-update-completions-test)            |
| Files           | n/a                                                                                    |
| Symbols         | n/a                                                                                    |
| Action          | Run `node scripts/tasks.mjs`. Investigate any failure and return to the failing phase. |
| Validate        | Run `node scripts/tasks.mjs`                                                           |
| Expected result | All checks (format, lint, type-check, knip, test, rebuild) pass.                       |

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) — full dev loop is green

```bash
node scripts/tasks.mjs
```

### [`VAL-002`](#5-testing--validation) — no source file imports from `lib/paths.js`

```bash
grep -r "from .*lib/paths" src __tests__
```

Expected: zero matches.

### [`VAL-003`](#5-testing--validation) — no source file references the deleted ALS / module-state helpers

```bash
grep -rE "setDefaultPathGuard|getDefaultPathGuard|withPathGuard|withAllowedDirectoriesState|setAllowedDirectoriesResolved|getActivePathGuard" src __tests__
```

Expected: zero matches.

### [`VAL-004`](#5-testing--validation) — contract test still recognizes all 18 tools

```bash
node --test --import tsx/esm __tests__/contract.test.ts
```

### [`VAL-005`](#5-testing--validation) — HTTP per-session isolation preserved

```bash
node --test --import tsx/esm __tests__/http.test.ts __tests__/security.test.ts
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                                     |
| :--------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | [src/lib/paths.ts](src/lib/paths.ts) does not exist.                                                                                                                   |
| [`AC-002`](#6-acceptance-criteria) | Every tool's `run` callback receives `ctx.pathGuard` and uses it for every path validation; no tool imports a free function from `paths.js`.                           |
| [`AC-003`](#6-acceptance-criteria) | [createTestEnv](__tests__/helpers.ts#L48) does not call any `setDefault*` function on `PathGuard`; tests instantiate guards explicitly.                                |
| [`AC-004`](#6-acceptance-criteria) | [src/server/bootstrap.ts](src/server/bootstrap.ts) does not call `withPathGuard`; HTTP isolation is achieved only via per-session `ToolRegistrationOptions.pathGuard`. |
| [`AC-005`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits 0.                                                                                                                                      |
| [`AC-006`](#6-acceptance-criteria) | The contract test ([**tests**/contract.test.ts](__tests__/contract.test.ts)) passes with all 18 tools registered.                                                      |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                                                                                          |
| :---------------------------: | :--: | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`RISK-001`](#7-risks--notes) | Risk | Helper functions inside [src/tools/edit-file.ts](src/tools/edit-file.ts), [src/tools/move-file.ts](src/tools/move-file.ts), and [src/tools/search-content.ts](src/tools/search-content.ts) currently take a `signal` but no `ctx` — adding a `pathGuard` parameter ripples through internal call chains. Mitigation: take `pathGuard: PathGuard` rather than the whole context. |
| [`RISK-002`](#7-risks--notes) | Risk | [src/lib/file-content.ts](src/lib/file-content.ts) is consumed widely; the signature change in [`TASK-008`](#task-008-add-pathguard-parameter-to-file-contentts-public-functions) must be done in lockstep with [`TASK-007`](#task-007-migrate-read-and-stat-tools). Mitigation: order tasks so `TASK-008` precedes `TASK-007`.                                                 |
| [`RISK-003`](#7-risks--notes) | Risk | The HTTP isolation guarantee depends on every tool obtaining its guard from the per-session `ToolRegistrationOptions`. If any tool reaches for ambient state after the migration, isolation breaks silently. Mitigation: [`VAL-002`](#5-testing--validation) and [`VAL-003`](#5-testing--validation) grep for residual imports.                                                 |
| [`NOTE-001`](#7-risks--notes) | Note | [isPathWithinDirectories](src/lib/path-guard.ts#L129) is intentionally kept as a pure free function — [src/server/roots-manager.ts](src/server/roots-manager.ts) uses it against a local array, not against guard state.                                                                                                                                                        |
| [`NOTE-002`](#7-risks--notes) | Note | `CON-001` (no new files) means the resolver pipeline (`normalizeAllowedDirectories`, `expandAllowedDirectories`, `resolveAllowedDirectoriesState`) lives next to [PathGuard](src/lib/path-guard.ts#L261). This is acceptable because they form its construction pipeline.                                                                                                       |
| [`NOTE-003`](#7-risks--notes) | Note | The sensitive-override env flag (`FS_CONTEXT_ALLOW_SENSITIVE`) is now read once, at guard construction. Re-reading at call time is no longer supported; this is an intentional locality improvement.                                                                                                                                                                            |
