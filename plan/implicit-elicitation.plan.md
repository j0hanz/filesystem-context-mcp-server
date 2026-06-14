# implicit-elicitation

Spec: [implicit-elicitation.specs.md](implicit-elicitation.specs.md)

## Goal

Replace the explicit `request_access` tool with an implicit, on-demand elicitation flow that intercepts access validation errors, prompts the user via elicitation, registers the approved directory dynamically, and retries the validation/operation.

## PHASE-001: Implementation

### TASK-001: Remove request_access tool registration and clean up references

Depends on: none
Files: [src/tools/index.ts](file:///C:/filesystem-mcp/src/tools/index.ts), [**tests**/helpers.ts](file:///C:/filesystem-mcp/__tests__/helpers.ts), [**tests**/contract.test.ts](file:///C:/filesystem-mcp/__tests__/contract.test.ts), [**tests**/unit/tool-registration.test.ts](file:///C:/filesystem-mcp/__tests__/unit/tool-registration.test.ts)
Symbols: [toolsRegistrar](file:///C:/filesystem-mcp/src/tools/index.ts#L32)
Satisfies: REQ-001
Action: Delete `src/tools/request-access.ts`. Remove `REQUEST_ACCESS` and its import from `src/tools/index.ts`. Remove the snapshot check and test helper references to `request_access` in the listed test files. Rebuild and run with schema update to regenerate tool snapshot.
Validate: `node --test --import tsx "__tests__/unit/tool-registration.test.ts"`
Expected result: The test passes, and `request_access` is no longer a registered tool.

### TASK-002: Add onAccessDenied callback property to PathGuard

Depends on: TASK-001
Files: [src/core/path.ts](file:///C:/filesystem-mcp/src/core/path.ts)
Symbols: [PathGuard](file:///C:/filesystem-mcp/src/core/path.ts#L506)
Satisfies: REQ-002
Action: Add the `onAccessDenied?: (blockedPath: string) => Promise<boolean>` callback signature to `PathGuard`'s properties.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: Compilation succeeds with the new property on PathGuard.

### TASK-003: Update containment checks to use checkAndPromptAccess in PathGuard

Depends on: TASK-002
Files: [src/core/path.ts](file:///C:/filesystem-mcp/src/core/path.ts)
Symbols: [PathGuard](file:///C:/filesystem-mcp/src/core/path.ts#L506)
Satisfies: REQ-003
Action: Implement `checkAndPromptAccess(checkPath: string, requestedPathForError: string): Promise<boolean>` helper in `PathGuard`. Change `validateAccess` and `validateAccessAndSensitivity` to be async. Update `validateAccess`, `validateSymlinkAccess`, `validateExistingPathDetailed`, `validatePathForWrite`, and `validatePathForDelete` to call `await this.checkAndPromptAccess(...)` and retry when it returns true.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: All TypeScript files compile cleanly.

### TASK-004: Wire onAccessDenied callback in executeTool

Depends on: TASK-003
Files: [src/tools/define.ts](file:///C:/filesystem-mcp/src/tools/define.ts)
Symbols: [executeTool](file:///C:/filesystem-mcp/src/tools/define.ts#L253)
Satisfies: REQ-004
Action: Register the `onAccessDenied` callback inside `ToolExecutor.execute` before running the tool's main function, and clear it in a `finally` block to prevent session leakage.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: TypeScript compilation succeeds.

### TASK-005: Only trigger onAccessDenied if elicitation is supported by client

Depends on: TASK-004
Files: [src/tools/define.ts](file:///C:/filesystem-mcp/src/tools/define.ts)
Symbols: [executeTool](file:///C:/filesystem-mcp/src/tools/define.ts#L253)
Satisfies: REQ-005
Action: Ensure the registered `onAccessDenied` callback checks `getClientCapabilities()?.elicitation` and only proceeds if elicitation is supported, returning false otherwise.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: TypeScript compilation succeeds.

### TASK-006: Resolve closest existing ancestor directory for elicitation

Depends on: TASK-005
Files: [src/tools/define.ts](file:///C:/filesystem-mcp/src/tools/define.ts)
Symbols: [executeTool](file:///C:/filesystem-mcp/src/tools/define.ts#L253)
Satisfies: REQ-006
Action: Implement `getClosestExistingDirectory` helper using `ctx.fs.statUnchecked` to walk up the directory tree starting from `blockedPath` until an existing directory is found, and use it as the path for elicitation.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: TypeScript compilation succeeds.

### TASK-007: Elicit approval, verify boundary, and call setRoots

Depends on: TASK-006
Files: [src/tools/define.ts](file:///C:/filesystem-mcp/src/tools/define.ts)
Symbols: [executeTool](file:///C:/filesystem-mcp/src/tools/define.ts#L253)
Satisfies: REQ-007
Action: Prompt user for access using the same schema-based elicitation form as before, check `FS_ROOT_BOUNDARY` if defined, and update allowed directory roots using `fs.setRoots(...)`.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: TypeScript compilation succeeds.

### TASK-008: Cache denials in ctx.denialCache

Depends on: TASK-007
Files: [src/tools/define.ts](file:///C:/filesystem-mcp/src/tools/define.ts)
Symbols: [executeTool](file:///C:/filesystem-mcp/src/tools/define.ts#L253)
Satisfies: REQ-008
Action: Before prompting the user, check `denialCache` for the target directory. If it is already denied, return `false` immediately. If the user declines approval, cache the denial.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: TypeScript compilation succeeds.

## PHASE-END: Acceptance

### TASK-009: Final acceptance verification

Depends on: TASK-008
Files: [**tests**/tools/elicitation.test.ts](file:///C:/filesystem-mcp/__tests__/tools/elicitation.test.ts)
Symbols: none
Satisfies: AC-001, AC-002, AC-003
Action: Rewrite integration tests in `__tests__/tools/elicitation.test.ts` to execute operations on blocked paths and verify they trigger implicit elicitation successfully, or fail/cache correctly.
Validate: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`
Expected result: All tests pass successfully.
