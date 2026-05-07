# PathGuard Design

**Date**: 2026-05-07
**Status**: Approved

## Problem

Path security enforcement is split across three files with no coherent seam:

- `src/lib/paths.ts` (975 LOC) — allowed-directory assertion, sensitive-file checks, path normalization utilities, and AsyncLocalStorage session state all cohabiting one file
- `src/lib/constants.ts` — `SENSITIVE_FILE_DENYLIST` pattern list (the policy behind the checks)
- `src/lib/globs.ts` (21 LOC) — orphaned `isSafeGlobPattern` function

Adding a new security rule requires knowing to update `constants.ts`, verify enforcement in `paths.ts`, and confirm `globs.ts` is still consistent. Testing requires priming an AsyncLocalStorage context (`setAllowedDirectoriesResolved`) in every test, with a teardown reset between runs. The security model has no single deletion test — the relevant code is spread across three files.

## Solution

Extract a `PathGuard` class into `src/lib/path-guard.ts` that owns all security enforcement. `paths.ts` retains only pure path-resolution utilities (~300 LOC). `globs.ts` is deleted.

## Architecture

`PathGuard` is a two-phase class matching the server initialization lifecycle:

```
Phase 1: new PathGuard(SENSITIVE_FILE_DENYLIST)
         — at server creation; compiles glob patterns once

Phase 2: pathGuard.initialize(allowedDirs)
         — when RootsManager resolves roots after client handshake
```

One `PathGuard` instance per server session:

- **stdio**: one singleton, created in `startServer()`, initialized when roots resolve
- **HTTP**: one per session, created in `createSessionServer()`, initialized per-session

`PathGuard` is passed as an explicit field on `ToolRegistrationOptions`, making the security dependency visible at every tool registration site. Resources and prompts receive it the same way. The `AsyncLocalStorage` in `paths.ts` is removed entirely.

## Interface

```typescript
class PathGuard {
  constructor(sensitivePatterns: readonly string[]);

  // Called by RootsManager when allowed dirs are resolved.
  initialize(allowedDirs: readonly string[]): void;

  // Normalizes path, calls realpath, asserts within allowed dirs.
  // Returns resolved path. Throws McpError if uninitialized or path escapes roots.
  assertAllowed(path: string): Promise<string>;

  // Returns true if path matches any sensitive-file pattern.
  // Safe to call before initialize() — patterns compiled at construction.
  isSensitive(path: string): boolean;

  // Returns true if glob pattern is safe (no traversal, no absolute escapes).
  // Stateless — no allowed dirs needed.
  isSafeGlob(pattern: string): boolean;
}
```

Design decisions:

- `assertAllowed` is `async` — it calls `realpath` internally and returns the resolved path, saving callers a separate filesystem round-trip.
- `isSensitive` works before `initialize()` — patterns are compiled in the constructor.
- `isSafeGlob` is pure and stateless — no filesystem access, no allowed dirs required.
- Calling `assertAllowed` before `initialize()` throws the same "not initialized" error that tools currently receive from the `isInitialized()` check. Tools keep their existing `isInitialized()` gate as the primary guard; PathGuard is defense-in-depth.

## What Moves Where

### New: `src/lib/path-guard.ts`

- `PathGuard` class
- Absorbs `isSafeGlobPattern` logic from `src/lib/globs.ts`
- Imports `SENSITIVE_FILE_DENYLIST` from `src/lib/constants.ts` (patterns stay there for auditability)

### Shrunk: `src/lib/paths.ts` (~975 → ~300 LOC)

Keeps (pure utilities, no state):

- `resolvePathOrRoot()`
- `normalizePath()`
- `expandPath()`
- `realpathSafe()`
- Windows-specific normalization (drive letters, UNC paths, reserved device names)

Removed:

- `allowedDirectoriesContext` (AsyncLocalStorage)
- `withAllowedDirectoriesState()`
- `setAllowedDirectoriesResolved()`
- `getAllowedDirectories()`
- `assertWithinAllowedDirectories()` → `pathGuard.assertAllowed()`
- `isSensitivePath()` → `pathGuard.isSensitive()`

### Deleted: `src/lib/globs.ts`

`isSafeGlobPattern` absorbed into `PathGuard` implementation.

## Integration Points

### `src/tools/contract.ts` (or `src/tools/shared.ts`)

`ToolRegistrationOptions` gains:

```typescript
pathGuard: PathGuard;
```

### `src/server/bootstrap.ts`

Creates `new PathGuard(SENSITIVE_FILE_DENYLIST)` at server construction. Wires `pathGuard.initialize(resolvedDirs)` into the existing roots-resolved callback from `RootsManager`. Passes `pathGuard` into `registerAllTools`, resource registration, and prompt registration.

### `src/server/roots-manager.ts`

Calls `pathGuard.initialize(resolvedDirs)` in the roots-resolved callback. No other changes.

### `src/tools/*.ts` (18 files)

Call-site changes only:

```typescript
// Before
assertWithinAllowedDirectories(path);
isSensitivePath(path);

// After
await pathGuard.assertAllowed(path);
pathGuard.isSensitive(path);
```

### `src/resources/*.ts` and `src/prompts.ts`

Same call-site updates. Registration functions gain a `pathGuard` parameter.

## Testing

### New: `__tests__/unit/path-guard.test.ts`

Drives `PathGuard` directly — no server, no transport, no ALS:

```typescript
// Happy path
const guard = new PathGuard(SENSITIVE_FILE_DENYLIST);
guard.initialize([tmpDir]);
const resolved = await guard.assertAllowed(join(tmpDir, 'file.txt'));

// Escape attempt
await assert.rejects(() => guard.assertAllowed('/etc/passwd'), /not allowed/);

// Sensitive file
assert.strictEqual(guard.isSensitive('.env'), true);
assert.strictEqual(guard.isSensitive('normal.txt'), false);

// Unsafe glob
assert.strictEqual(guard.isSafeGlob('../**'), false);
assert.strictEqual(guard.isSafeGlob('*.ts'), true);

// Uninitialized
const uninit = new PathGuard(SENSITIVE_FILE_DENYLIST);
await assert.rejects(() => uninit.assertAllowed(path), /not initialized/);
assert.strictEqual(uninit.isSensitive('.env'), true); // works before initialize()
```

### `__tests__/helpers.ts`

`createTestEnv` constructs a `PathGuard` and calls `initialize([tmpDir])` before returning. The `setAllowedDirectoriesResolved` call and its teardown reset are removed. Tests that need a non-standard guard construct one directly.

### Existing integration tests

No assertion changes — behavior is identical. Setup simplifies (one fewer global-state call).

### `__tests__/contract.test.ts`

No changes — tests tool registration shape, not path security.

## File Change Summary

| File                                | Change                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `src/lib/path-guard.ts`             | **New** — `PathGuard` class                                                     |
| `src/lib/paths.ts`                  | Loses ~675 LOC (ALS + security functions); keeps ~300 LOC utilities             |
| `src/lib/globs.ts`                  | **Deleted** — absorbed into `PathGuard`                                         |
| `src/tools/contract.ts`             | `ToolRegistrationOptions` gains `pathGuard: PathGuard`                          |
| `src/server/bootstrap.ts`           | Creates `PathGuard`, wires `initialize` into roots callback, passes through     |
| `src/server/roots-manager.ts`       | Calls `pathGuard.initialize()` on roots resolved                                |
| `src/tools/*.ts` (18 files)         | Call-site updates: `assertWithinAllowedDirectories` → `pathGuard.assertAllowed` |
| `src/resources/*.ts`                | Same call-site updates                                                          |
| `src/prompts.ts`                    | Same call-site updates                                                          |
| `__tests__/helpers.ts`              | Constructs `PathGuard`, removes ALS setup/teardown                              |
| `__tests__/unit/path-guard.test.ts` | **New** — unit tests                                                            |
