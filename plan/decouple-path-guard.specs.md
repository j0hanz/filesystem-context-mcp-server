# decouple-path-guard

## 1. Goal

- Decouple PathGuard from MCP Server Roots to separate filesystem domain validation from transport protocol lifecycles
- Completion signal: Full test suite passes and `src/core/path.ts` has zero imports of `@modelcontextprotocol/server`.

## 2. Requirements

- `REQ-001`: `PathGuard` class MUST NOT import or depend on `@modelcontextprotocol/server`.
- `REQ-002`: `PathGuard` class MUST expose a `setRoots(resolvedRoots: readonly string[])` method to update allowed directories.
- `REQ-003`: `McpRootsSynchronizer` class MUST coordinate MCP lifecycle notifications including `notifications/initialized`.
- `REQ-004`: `McpRootsSynchronizer` class MUST coordinate `notifications/roots/list_changed` lifecycle events.
- `REQ-005`: `McpRootsSynchronizer` class MUST fetch roots from the client.
- `REQ-006`: `McpRootsSynchronizer` MUST handle initialized handshake timeout events using the configured timeout threshold.
- `REQ-007`: `McpRootsSynchronizer` MUST expose a `destroy()` method to cancel active initialization timers.
- `REQ-008`: The system MUST relocate helper functions resolving roots from `src/core/path.ts` to `src/core/registrar.ts`.
- `REQ-009`: The system MUST relocate the MCP directory warning logging logic out of `src/core/path.ts`.

## 3. Constraints

- `CON-001`: Path containment and sandboxing rules MUST behave identically.
- `CON-002`: All existing tool execution paths and directory validation checks MUST NOT be modified in behavior.

## 4. Interfaces

The system exposes the following interfaces:

**PathGuard**

- Method: `setRoots(resolvedRoots: readonly string[])`
  - Input: `resolvedRoots` (readonly string[], required): List of absolute, resolved paths to set as active root directories.
  - Output: `Promise<void>`: Resolves when allowed directories state is updated.
  - Errors: `FsError`: If root directory checks fail due to system-level permissions.

**McpRootsSynchronizer**

- Method: `registerHandlers(server: McpServer, onInitTimeout?: () => void)`
  - Input: `server` (McpServer, required): The MCP server instance to attach notification handlers to.
  - Input: `onInitTimeout` (function, optional): Callback invoked if client initialized handshake times out.
  - Output: `void`
  - Errors: None (fails silently or logs warning on timeout or missing capabilities).
- Method: `logMissingDirectoriesIfNeeded(server: McpServer)`
  - Input: `server` (McpServer, required): The MCP server instance to write logs to.
  - Output: `void`
  - Errors: None
- Method: `destroy()`
  - Input: None
  - Output: `void`
  - Errors: None

## 5. Context

- Files: `src/core/path.ts`, `src/server.ts`, `src/transport.ts`, `src/core/registrar.ts`
- Current behavior: `PathGuard` registers event handlers on the MCP server directly and polls allowed roots, causing delivery/transport logic to bleed into path security logic.

## 6. Acceptance Criteria & Validation

- `AC-001`: Core unit, security, and tool tests run successfully.
- `VAL-001`: `npm test`
- `AC-002`: `src/core/path.ts` contains no import references to `@modelcontextprotocol/server`.
- `VAL-002`: `git grep -F "@modelcontextprotocol/server" -- src/core/path.ts || exit 0`
- `AC-003`: `McpRootsSynchronizer` cleans up pending debounced updates and handshake timers on destruction.
- `VAL-003`: `npm test -- __tests__/unit/path-guard-roots.test.ts`
- `AC-004`: `PathGuard.setRoots` successfully updates allowed directories and restricts access to them.
- `VAL-004`: `npm test -- __tests__/unit/path-guard.test.ts`
- `AC-005`: `McpRootsSynchronizer` attaches to `McpServer` and successfully updates `PathGuard` with client roots.
- `VAL-005`: `npm test -- __tests__/unit/path-guard-roots.test.ts`
- `AC-006`: `McpRootsSynchronizer` correctly detects initialization timeouts and logs client warnings.
- `VAL-006`: `npm test -- __tests__/unit/path-guard-roots.test.ts`

## 7. Examples & Edge Cases

**Positive example:**

```typescript
const guard = new PathGuard(options);
await guard.setRoots(['C:\\projects\\my-workspace']);
const isSafe = await guard.validatePath('C:\\projects\\my-workspace\\file.txt'); // Safe
```

**Edge cases:**

- Stdio connection has no roots capability: `McpRootsSynchronizer` will pass an empty array to `PathGuard.setRoots`.
- Initialization Timeout: `McpRootsSynchronizer` schedules the warning logging and triggers the timeout callback, but path security continues using default allowed directories.
