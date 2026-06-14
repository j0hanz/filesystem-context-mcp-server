# implicit-elicitation

## 1. Goal

- Replace the explicit `request_access` tool with an implicit, on-demand elicitation flow that intercepts access validation errors, prompts the user via elicitation, registers the approved directory dynamically, and retries the validation/operation.
- Completion signal: The `request_access` tool is completely removed from the registry, and reading/writing/listing files outside allowed directories triggers an inline elicitation prompt on elicitation-capable clients, succeeding when accepted and failing when rejected.

## 2. Requirements

- `REQ-001`: The `request_access` tool MUST be completely removed from the server's tool registration.
- `REQ-002`: `PathGuard` MUST expose a mutable `onAccessDenied?: (blockedPath: string) => Promise<boolean>` callback.
- `REQ-003`: When `PathGuard` performs containment checks (in `validateAccess`, `validateSymlinkAccess`, `validateExistingPathDetailed`, `validatePathForWrite`, `validatePathForDelete`), if the check fails, it MUST invoke `onAccessDenied(blockedPath)` if registered. If the callback returns `true`, `PathGuard` MUST re-evaluate the containment check using the updated allowed directories. If the callback returns `false` or is not registered, it MUST throw the original `ACCESS_DENIED` error.
- `REQ-004`: `executeTool` in `src/tools/define.ts` MUST register the `onAccessDenied` callback on the active `PathGuard` instance for the duration of the tool execution, clearing it in a `finally` block to prevent session leakage.
- `REQ-005`: The registered `onAccessDenied` callback MUST only trigger if the client advertises `elicitation` capability and `elicitInput` is available.
- `REQ-006`: The callback MUST determine the closest existing directory ancestor of the blocked path using unchecked stat/realpath calls, and use that directory as the target for elicitation.
- `REQ-007`: The callback MUST prompt the user for access approval. If approved, it MUST verify the target directory is within `FS_ROOT_BOUNDARY` (if configured) and then add the directory to the allowed directories list via `fs.setRoots(...)`. If rejected or outside boundary, the callback MUST return `false`.
- `REQ-008`: The callback MUST cache denials in `ctx.denialCache` (if present) per target directory. Subsequent accesses to paths inside a cached denied directory MUST be rejected immediately without prompting the user.

## 3. Constraints

- `CON-001`: The solution MUST NOT add any new tools to the registry.
- `CON-002`: The solution MUST NOT persist dynamic permission approvals across server restarts or different client sessions.

## 4. Interfaces

The system exposes the following interfaces:

### PathGuard.onAccessDenied

**Type:** `((blockedPath: string) => Promise<boolean>) | undefined`

**Input:**

- `blockedPath` (string, required): The path that failed the allowed directory check.

**Output:**

- `Promise<boolean>`: Resolves to `true` if access was dynamically granted, `false` otherwise.

## 5. Context

- Files:
  - [src/core/path.ts](file:///C:/filesystem-mcp/src/core/path.ts)
  - [src/tools/define.ts](file:///C:/filesystem-mcp/src/tools/define.ts)
  - [src/tools/index.ts](file:///C:/filesystem-mcp/src/tools/index.ts)
  - [**tests**/tools/elicitation.test.ts](file:///C:/filesystem-mcp/__tests__/tools/elicitation.test.ts)
- Current behavior: An explicit `request_access` tool exists and must be called by the client/agent before accessing a directory outside allowed roots.
- Conventions: Use standard ESM imports, RE2 for regex safety, and build-in node test runner.

## 6. Acceptance Criteria & Validation

- `AC-001`: Performing a `read` or `list` tool call on a path outside allowed directories triggers elicitation, and if the user approves, the tool call completes successfully.
- `VAL-001`: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`
- `AC-002`: Performing a tool call on a path outside allowed directories fails with `ACCESS_DENIED` if the user declines elicitation, caching the denial.
- `VAL-002`: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`
- `AC-003`: Performing a tool call on a path outside allowed directories fails with `ACCESS_DENIED` if the client does not support elicitation.
- `VAL-003`: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`

## 7. Examples & Edge Cases

**Positive example:**

```
Client reads `/unconfigured/project/file.txt`
Elicitation is triggered for `/unconfigured/project`
User approves
Access is added to roots
Read succeeds
```

**Edge cases:**

- [Directory does not exist → walks up to closest existing ancestor directory for elicitation]
- [Target outside boundary → fails after user approval with ACCESS_DENIED]
- [Subsequent access to denied directory → returns cached denial immediately]
