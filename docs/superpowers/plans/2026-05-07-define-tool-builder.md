# defineTool Builder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the per-tool registration boilerplate (currently repeated across 18 files in [src/tools/](../../../src/tools/)) into a single deep `defineTool` builder. Each tool file shrinks to a `ToolContract` plus a single `run(args, ctx) → ToolResponse<Output>`. The builder dispatches task-mode internally via `contract.taskSupport`. **No behavior change.**

**Architecture:** `defineTool` is a thin facade over today's [executeToolWithDiagnostics](../../../src/tools/shared.ts) + [wrapToolHandler](../../../src/tools/shared.ts) + [registerStandardTool](../../../src/tools/task-support.ts). It returns a `DefinedTool` object `{ contract, register }`. [src/tools.ts](../../../src/tools.ts) iterates a flat `DefinedTool[]` and calls `tool.register(server, options)`. Per-tool helpers (`handle<Name>`, `to<Name>StructuredResult`, `build<Name>ProgressMessage`, `build<Name>CompletionMessage`, `register<Name>Tool`) are inlined or absorbed into the builder. Pure-function-for-testability extractions are **collapsed** unless the helper is genuinely complex (e.g. patch parsing, diff parsing).

**Out of scope:**

- Externalization policy (deepening candidate #6) — `run` keeps current per-tool externalization.
- Splitting `registerStandardTool` into two entry points (candidate #4) — internal dispatch only.
- Splitting `src/tools/shared.ts` (candidate #2) — this plan only **removes** call sites; later cleanup can move pieces.
- `src/lib/paths.ts` consolidation (candidate #3).

**Tech stack:** TypeScript, Zod v4, `@modelcontextprotocol/server` 2.0.0-alpha, `node:test`.

---

## File Map

| Action         | File                                 | Responsibility                                                              |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Create         | `src/tools/define-tool.ts`           | `defineTool`, `DefinedTool`, `ToolRunContext` types and runtime             |
| Create         | `__tests__/unit/define-tool.test.ts` | Unit tests for the builder (guard, dispatch, message wiring, error mapping) |
| Modify         | `src/tools.ts`                       | `TOOL_ENTRIES: DefinedTool[]`; loop calls `t.register(server, options)`     |
| Modify         | `src/tools/contract.ts`              | Add optional `defaultTimeoutMs?: number` to `ToolContract`                  |
| Modify         | `src/tools/read.ts`                  | Migrate to `defineTool`; export `READ_FILE` (DefinedTool)                   |
| Modify         | `src/tools/write-file.ts`            | Same                                                                        |
| Modify         | `src/tools/stat.ts`                  | Same                                                                        |
| Modify         | `src/tools/stat-many.ts`             | Same                                                                        |
| Modify         | `src/tools/roots.ts`                 | Same                                                                        |
| Modify         | `src/tools/list-directory.ts`        | Same                                                                        |
| Modify         | `src/tools/tree.ts`                  | Same                                                                        |
| Modify         | `src/tools/create-directory.ts`      | Same                                                                        |
| Modify         | `src/tools/delete-file.ts`           | Same                                                                        |
| Modify         | `src/tools/move-file.ts`             | Same                                                                        |
| Modify         | `src/tools/calculate-hash.ts`        | Same                                                                        |
| Modify         | `src/tools/diff-files.ts`            | Same                                                                        |
| Modify         | `src/tools/read-multiple.ts`         | Same                                                                        |
| Modify         | `src/tools/edit-file.ts`             | Same                                                                        |
| Modify         | `src/tools/search-files.ts`          | Same                                                                        |
| Modify         | `src/tools/search-content.ts`        | Same (task-capable)                                                         |
| Modify         | `src/tools/replace-in-files.ts`      | Same (task-capable)                                                         |
| Modify         | `src/tools/apply-patch.ts`           | Same                                                                        |
| Modify (later) | `src/tools/shared.ts`                | Reduce visibility of internal primitives once migration is done             |
| Modify (later) | `src/tools/task-support.ts`          | Same                                                                        |

---

## Phases

1. **Builder foundation** — implement `defineTool` as a wrapper, no migrations. CI green.
2. **Migrate simple tools** — `write-file`, `stat`, `stat-many`, `roots`, `create-directory`. Validates the API on the easy cases.
3. **Migrate medium tools** — `read`, `delete-file`, `list-directory`, `tree`, `read-multiple`, `move-file`, `diff-files`, `calculate-hash`.
4. **Migrate complex tools** — `edit-file`, `search-files`, `apply-patch`.
5. **Migrate task-capable tools** — `search-content`, `replace-in-files`. Validates the task-mode dispatch path.
6. **Internalize legacy primitives** — drop `export` on `executeToolWithDiagnostics`, `wrapToolHandler`, `registerStandardTool` if no callers remain. Optional `CONTEXT.md` write-up.

Each phase ends with a green `node scripts/tasks.mjs` run.

---

## Task 1: Implement `defineTool` (Phase 1)

**Files:**

- Create: `src/tools/define-tool.ts`
- Create: `__tests__/unit/define-tool.test.ts`
- Modify: `src/tools/contract.ts`

- [ ] **Step 1.1: Add `defaultTimeoutMs` to `ToolContract`**

In [src/tools/contract.ts](../../../src/tools/contract.ts), add an optional field:

```ts
/**
 * Default timeout in ms applied by the registration builder. If omitted,
 * no timeout is wired (tool's own `signal` lifetime applies).
 */
defaultTimeoutMs?: number;
```

Place it next to `taskSupport`. No tool sets it yet.

- [ ] **Step 1.2: Write failing unit tests**

Create `__tests__/unit/define-tool.test.ts` covering:

1. `defineTool` returns `{ contract, register }` whose `contract` is the passed contract by reference.
2. Calling `register(server, options)` on a non-task tool ends up calling `server.registerTool` with `contract.name`, `contract.inputSchema`, `contract.outputSchema` (via wire conversion) and a wrapped handler.
3. The wrapped handler:
   - returns the not-initialized error when `options.isInitialized?.() === false`;
   - validates `args` with `contract.inputSchema` and produces an `INVALID_INPUT` error result on schema failure;
   - calls `run(args, ctx)` exactly once with a derived `ToolRunContext` whose `signal` is non-undefined when `contract.defaultTimeoutMs` is set;
   - validates the response against `contract.outputSchema`;
   - on thrown error, returns a `buildToolErrorResponse`-shaped result with `errorCode` derived from the thrown error or `ErrorCode.UNKNOWN`.
4. `progressMessage` and `completionMessage` are forwarded into `wrapToolHandler` (assert via observed `notifications/progress` text using a fake transport — reuse `linked-transport.ts`).
5. When `contract.taskSupport !== 'forbidden'` and `options.hasTaskSupport === true`, `defineTool` registers via the task path (assert `tryRegisterToolTask` was invoked — spy via a stubbed `server`).

Run tests; expect failure.

```sh
node --test --import tsx/esm __tests__/unit/define-tool.test.ts
```

Expected: file fails to compile because `define-tool.ts` does not exist.

- [ ] **Step 1.3: Implement `defineTool`**

Create `src/tools/define-tool.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';

import type { ToolContract } from './contract.js';
import {
  buildToolErrorResponse,
  executeToolWithDiagnostics,
  type ToolContext,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export interface ToolRunContext extends ToolContext {
  signal: AbortSignal | undefined;
  resourceStore: ToolRegistrationOptions['resourceStore'];
}

export interface DefineToolOptions<
  Args,
  Output extends Record<string, unknown>,
> {
  contract: ToolContract;
  run: (args: Args, ctx: ToolRunContext) => Promise<ToolResponse<Output>>;
  progressMessage?: (args: Args) => string;
  completionMessage?: (
    args: Args,
    result: ToolResult<Output>
  ) => string | undefined;
  /** Default: `{ path: (args as { path?: string }).path }`. */
  diagnosticsContext?: (args: Args) => Record<string, unknown>;
  /** Default: `ErrorCode.UNKNOWN`. */
  defaultErrorCode?: ErrorCode;
}

export interface DefinedTool {
  readonly contract: ToolContract;
  register(server: McpServer, options: ToolRegistrationOptions): void;
}

export function defineTool<Args, Output extends Record<string, unknown>>(
  opts: DefineToolOptions<Args, Output>
): DefinedTool {
  const { contract, run } = opts;
  const errorCode = opts.defaultErrorCode ?? ErrorCode.UNKNOWN;
  const diagnosticsContext =
    opts.diagnosticsContext ??
    ((args: Args) => {
      const path = (args as { path?: string }).path;
      return path !== undefined ? { path } : {};
    });

  const handler = (args: Args, ctx: ToolContext): Promise<ToolResult<Output>> =>
    executeToolWithDiagnostics<Output>({
      toolName: contract.name,
      ctx,
      ...(contract.outputSchema
        ? { outputSchema: contract.outputSchema as z.ZodType<Output> }
        : {}),
      ...(contract.defaultTimeoutMs !== undefined
        ? { timedSignal: { timeoutMs: contract.defaultTimeoutMs } }
        : { timedSignal: {} }),
      context: diagnosticsContext(args),
      run: async (signal) => {
        const runCtx: ToolRunContext = Object.assign({}, ctx, {
          signal,
          resourceStore: undefined as ToolRegistrationOptions['resourceStore'],
        });
        return run(args, runCtx);
      },
      onError: (error) =>
        buildToolErrorResponse(
          error,
          errorCode,
          diagnosticsContext(args).path as string | undefined
        ),
    });

  return {
    contract,
    register(server, options) {
      // Inject resourceStore into the run context via closure on `options`.
      const wrapped = (args: Args, ctx: ToolContext) => {
        const runCtx = ctx as ToolRunContext;
        runCtx.resourceStore = options.resourceStore;
        return handler(args, runCtx);
      };
      registerStandardTool(server, contract, wrapped, options, {
        ...(opts.progressMessage
          ? { progressMessage: opts.progressMessage }
          : {}),
        ...(opts.completionMessage
          ? { completionMessage: opts.completionMessage }
          : {}),
      });
    },
  };
}
```

Notes:

- `resourceStore` is injected from `options` at registration time so `run` can call externalization helpers without a separate parameter. Kept on the run context to align with future candidate #6.
- The conditional spreads honor `exactOptionalPropertyTypes`.
- Task vs standard dispatch is **already handled by `registerStandardTool`** today via `registerToolTaskIfAvailable`. No new dispatch logic here.

- [ ] **Step 1.4: Re-run unit tests; expect green**

```sh
node --test --import tsx/esm __tests__/unit/define-tool.test.ts
```

- [ ] **Step 1.5: Validate**

```sh
node scripts/tasks.mjs --quick
```

Expected: lint, type-check, knip clean. No existing test should fail since no tools migrated yet.

---

## Task 2: Migrate simple tools (Phase 2)

**Files:**

- Modify: `src/tools/write-file.ts`, `src/tools/stat.ts`, `src/tools/stat-many.ts`, `src/tools/roots.ts`, `src/tools/create-directory.ts`
- Modify: `src/tools.ts`

For each tool:

- [ ] **Step 2.x.1: Replace the file's bottom half (handler + register fn) with a `defineTool` call**

Pattern, using [src/tools/write-file.ts](../../../src/tools/write-file.ts) as the canonical example:

**Before** (lines ~43–90): `handleWriteFile`, then `registerWriteFileTool` with a `handler` closure invoking `executeToolWithDiagnostics`.

**After:**

```ts
export const WRITE_FILE = defineTool<
  z.infer<typeof WriteFileInputSchema>,
  z.infer<typeof WriteFileOutputSchema>
>({
  contract: WRITE_FILE_TOOL,
  run: async (args, ctx) => {
    const validPath = await validatePathForWrite(args.path ?? '', ctx.signal);
    await withAbort(mkdir(dirname(validPath), { recursive: true }), ctx.signal);
    await atomicWriteFile(validPath, args.content, {
      encoding: 'utf-8',
      signal: ctx.signal,
    });
    const bytesWritten = Buffer.byteLength(args.content, 'utf-8');
    Logger.info(`write: ${args.path} (${bytesWritten} bytes)`);
    void ctx.log?.(
      'info',
      `write: ${args.path} (${bytesWritten} bytes)`,
      'write'
    );
    return buildToolResponse(`Successfully wrote to file: ${args.path}`, {
      ok: true,
      path: validPath,
      bytesWritten,
    });
  },
});
```

Remove `registerWriteFileTool`, the `handler` const, `handleWriteFile`, and any unused imports (`executeToolWithDiagnostics`, `buildToolErrorResponse`, `ToolContext`, `ToolResult`, `ToolRegistrationOptions`, `registerStandardTool`).

The `WRITE_FILE_TOOL` contract const stays as-is (still consumed by `tool-info.ts`). Only the _registration plumbing_ is replaced.

- [ ] **Step 2.x.2: Update `src/tools.ts` registry entry**

Change the entry from `{ contract: WRITE_FILE_TOOL, register: registerWriteFileTool }` (or whatever shape `TOOL_ENTRIES` currently uses) to `WRITE_FILE` directly. **Confirm the actual shape of `TOOL_ENTRIES` before editing** — read [src/tools.ts](../../../src/tools.ts) first; the migration may need to be done in two sub-steps if the registry currently expects a different shape.

If `TOOL_ENTRIES` currently uses `{ contract, register }`, add a one-line adapter at first: `{ contract: WRITE_FILE.contract, register: WRITE_FILE.register }`. Once **all** tools are migrated (end of Phase 5), simplify `TOOL_ENTRIES` to `DefinedTool[]`.

- [ ] **Step 2.x.3: Run full test suite**

```sh
node scripts/tasks.mjs
```

Expected: all tests pass. The contract test [`__tests__/contract.test.ts`](../../../__tests__/contract.test.ts) verifies all 18 tools are registered with correct annotations — must remain green.

Apply the same three sub-steps to `stat.ts`, `stat-many.ts`, `roots.ts`, `create-directory.ts`. Do them one at a time, validating after each.

---

## Task 3: Migrate medium tools (Phase 3)

Same procedure as Task 2, applied to:

- [ ] `src/tools/read.ts` — has `progressMessage` (`buildReadProgressMessage`), `completionMessage` (`buildReadCompletionMessage`), and externalization. Pass `progressMessage` and `completionMessage` to `defineTool`. Move `maybeBuildExternalizedReadResponse` and its helpers (`buildReadResourceName`, `toStructuredReadFileResult`, `buildReadOptions`) into the `run` closure or keep as module-level helpers (fine either way). The `resourceStore` is now `ctx.resourceStore`.
- [ ] `src/tools/delete-file.ts`
- [ ] `src/tools/list-directory.ts`
- [ ] `src/tools/tree.ts`
- [ ] `src/tools/read-multiple.ts`
- [ ] `src/tools/move-file.ts` — `diagnosticsContext: (args) => ({ source: args.source, destination: args.destination })`.
- [ ] `src/tools/diff-files.ts` — same dual-path diagnosticsContext.
- [ ] `src/tools/calculate-hash.ts`

Validate after each:

```sh
node scripts/tasks.mjs
```

---

## Task 4: Migrate complex tools (Phase 4)

- [ ] `src/tools/edit-file.ts` — keep any pure helpers (e.g. patch application) exported as before; only the registration plumbing changes.
- [ ] `src/tools/search-files.ts`
- [ ] `src/tools/apply-patch.ts` — keep `parsePatch`/diff helpers exported for unit tests.

Validate after each.

---

## Task 5: Migrate task-capable tools (Phase 5)

The dispatch question (Q3 in the design discussion) was decided **(a) — single entry point, internal dispatch on `contract.taskSupport`**. This means task-capable tools use `defineTool` exactly the same way as standard tools; the existing `registerStandardTool` already calls `registerToolTaskIfAvailable` first.

- [ ] `src/tools/search-content.ts` — `taskSupport: 'optional'`. Verify task-mode integration test still passes ([`__tests__/tools/task-mode.test.ts`](../../../__tests__/tools/task-mode.test.ts)).
- [ ] `src/tools/replace-in-files.ts` — same.

Validate:

```sh
node --test --import tsx/esm __tests__/tools/task-mode.test.ts
node scripts/tasks.mjs
```

---

## Task 6: Tighten registry and internalize primitives (Phase 6)

- [ ] **Step 6.1:** Simplify `src/tools.ts`:

```ts
import { READ_FILE } from './tools/read.js';
import { WRITE_FILE } from './tools/write-file.js';

// ... 16 more

export const TOOLS: readonly DefinedTool[] = [
  READ_FILE,
  WRITE_FILE /* ... */,
] as const;

export function registerAllTools(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  for (const tool of TOOLS) tool.register(server, options);
}
```

Remove any per-tool `register*Tool` re-exports that no longer have callers (verify with `grep_search`).

- [ ] **Step 6.2:** Audit `src/tools/shared.ts` and `src/tools/task-support.ts` for now-unused exports. Likely candidates to make non-`export`:
  - `executeToolWithDiagnostics` (only `define-tool.ts` calls it)
  - `wrapToolHandler` (only `registerStandardTool` calls it)
  - `registerStandardTool` (only `define-tool.ts` calls it)

  Use `grep_search` to confirm zero external callers (including tests) before removing `export`. If a test calls them, leave the export and add a comment.

- [ ] **Step 6.3:** Update [`__tests__/contract.test.ts`](../../../__tests__/contract.test.ts) only if it references the old per-tool `register*Tool` symbols. The contract data model (`TOOLS[i].contract`) should be unchanged.

- [ ] **Step 6.4:** Run full validation.

```sh
node scripts/tasks.mjs
```

- [ ] **Step 6.5 (optional):** Create `CONTEXT.md` at repo root pinning the terms `DefinedTool`, `ToolRunContext`, and `ToolContract`. Skip if `CONTEXT.md` is not part of this repo's convention.

---

## Validation

Run after **every** task:

```sh
node scripts/tasks.mjs
```

Expected output: format/lint/type-check/knip/test/build all green. The contract test enumerates all 18 tools — any drop or annotation drift fails it.

Spot-check tests during migration:

```sh
node --test --import tsx/esm __tests__/contract.test.ts
node --test --import tsx/esm __tests__/tools/read-write.test.ts
node --test --import tsx/esm __tests__/tools/task-mode.test.ts
node --test --import tsx/esm __tests__/unit/tool-registration.test.ts
```

---

## Acceptance Criteria

1. All 18 tool files export a single `DefinedTool` (e.g. `READ_FILE`, `WRITE_FILE`) and no longer export `register*Tool` functions.
2. `src/tools.ts` exports a `TOOLS: readonly DefinedTool[]` and a single `registerAllTools(server, options)` whose body is a `for…of` loop.
3. `defineTool` is the only call site of `executeToolWithDiagnostics` and `registerStandardTool`. (Verify via `grep_search`.)
4. `node scripts/tasks.mjs` is fully green: format, lint (0 warnings), type-check, knip, all 73+ tests, build.
5. The wire-format JSON Schema for every tool is byte-identical before vs after migration. Verify by snapshot:

   ```sh
   node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
   ```

   No snapshot updates required.

6. Each migrated tool file is **shorter** than before, with the registration scaffold (per-tool `handle*`, `register*Tool`, `handler` closure) removed.
7. The MCP Inspector smoke test still works:

   ```sh
   npm run inspector
   ```

   Manually invoke `read`, `write`, and `grep` (search-content) and verify success + progress notifications arrive.

---

## Rollback

If a phase regresses, revert that phase's commit. Because each phase ends green, partial migrations are safe — `defineTool` is a wrapper, not a replacement, and unmigrated tools continue to work unchanged.
