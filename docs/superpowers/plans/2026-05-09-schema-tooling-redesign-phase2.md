# Schema & Tooling Redesign — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate all 18 existing tools to the new `defineTool()` engine, eliminate the legacy 5-layer pipeline, consolidate the server bootstrap into `src/server.ts`, and collapse `src/resources/` into `src/resources.ts`.

**Architecture:**

Phase 1 established `src/schema.ts` and `src/tools/define.ts`. Phase 2 wires Phase 1's engine into every tool, removes the legacy pipeline (`define-tool.ts`, `tool-execution.ts`, `contract.ts`, `progress-sinks.ts`, `icons.ts`), consolidates `src/server/` (5 files → `src/server.ts`), and collapses `src/resources/` (5 files → `src/resources.ts`).

**Tech Stack:** TypeScript, Node.js, Zod v4, `@modelcontextprotocol/server`

**Key Contract Changes (handlers):**

- Handler now returns `z.infer<O>` directly (plain data object), not `ToolResult<T>`.
- Errors are thrown as `McpError` — never returned as `buildToolErrorResponse`.
- `ctx.log` is `(level: LoggingLevel, message: string, ctx?: string) => void` (same as existing `ctx.log` call signature). Log calls like `await ctx.log?.('info', msg)` become `ctx.log('info', msg)`.
- `putResource(ctx, ...)` → use `ctx.resourceStore.set(...)` inline; include URI in output schema fields directly.
- `buildToolResponse(text, data)` → `return data`.
- `buildResourceResponse(...)` → `return data` (resource links come from resourceUri fields in the output schema).

**Important invariant:** `npm run tasks` must pass after every commit.

---

## File Map

**Files Modified:**

- `src/tools/define.ts` — production-ready fix (Task 1)
- `src/tools.ts` — switch to ALL_TOOLS from define.ts (Task 8)

**Files Created:**

- (none — all migrations are in-place edits of existing tool files)

**Files Deleted** (after all tools migrated, Task 8):

- `src/tools/define-tool.ts`
- `src/tools/tool-execution.ts`
- `src/tools/contract.ts`
- `src/tools/progress-sinks.ts`
- `src/tools/icons.ts`
- `src/tools/shared.ts` (completely — cursor/batch helpers move into individual tool files that use them)

**Files Migrated (in-place):**

- `src/tools/roots.ts` (Task 2)
- `src/tools/create-directory.ts` (Task 2)
- `src/tools/diff-files.ts` (Task 2)
- `src/tools/write-file.ts` (Task 3)
- `src/tools/move-file.ts` (Task 3)
- `src/tools/delete-file.ts` (Task 3)
- `src/tools/stat.ts` (Task 4)
- `src/tools/calculate-hash.ts` (Task 4)
- `src/tools/read.ts` (Task 4)
- `src/tools/stat-many.ts` (Task 5)
- `src/tools/read-multiple.ts` (Task 5)
- `src/tools/list-directory.ts` (Task 5)
- `src/tools/search-files.ts` (Task 5)
- `src/tools/tree.ts` (Task 5)
- `src/tools/edit-file.ts` (Task 6)
- `src/tools/apply-patch.ts` (Task 6)
- `src/tools/replace-in-files.ts` (Task 6)
- `src/tools/search-content.ts` (Task 7)

**Server Consolidation:**

- CREATE: `src/server.ts` (Task 9)
- DELETE: `src/server/bootstrap.ts`, `src/server/roots-manager.ts`, `src/server/task-orchestrator.ts`, `src/server/task-store.ts`, `src/server/event-store.ts`, `src/server/` folder (Task 9)

**Resources Consolidation:**

- MERGE into: `src/resources.ts` (already exists, augment it) (Task 10)
- DELETE: `src/resources/contract.ts`, `src/resources/filesystem.ts`, `src/resources/instructions.ts`, `src/resources/result.ts`, `src/resources/shared.ts`, `src/resources/` folder (Task 10)

---

## Reference: New `ToolCtx` Interface

Every tool handler receives a `ToolCtx` with:

```ts
interface ToolCtx {
  readonly signal: AbortSignal;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly log: (level: LoggingLevel, message: string, ctx?: string) => void;
  readonly elicit?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}
```

The `log` function is a thin wrapper over the MCP session log. When migrating, replace:

```ts
await ctx.log?.('info', 'message', 'context');
```

with:

```ts
ctx.log('info', 'message', 'context');
```

---

## Reference: `putResource` migration

Old pattern:

```ts
const { entry, link } = putResource({ store: ctx.resourceStore, name, mimeType, kind, content });
return buildResourceResponse({ summary: text, resources: [link], structured: { ..., resourceUri: entry.uri } });
```

New pattern (handler returns data directly):

```ts
const result = ctx.resourceStore.set({ name, content, mimeType, ...  });
return { ..., resourceUri: result.uri }; // resourceUri must be in output schema
```

Check `src/core/store.ts` for the `ResourceStore.set()` API before migrating each tool.

---

## Task 1: Fix `src/tools/define.ts` for Production

**Files:** Modify: `src/tools/define.ts`

This task rewrites `define.ts` to be fully production-ready:

- Fix Zod import (`zod` → `zod/v4`)
- Fix `ToolCtx.log` type to `(level: LoggingLevel, message: string, ctx?: string) => void`
- Fix `composeAbortSignals` — import from `../core/concurrency.js` instead of re-implementing
- Fix `ProgressSession` — wire real MCP progress sinks by accepting an extra `ctx` parameter from the MCP server, using `McpProgressSink` from the existing `progress-sinks.ts`
- Fix `McpError` constructor calls to use the `(code, message, path?)` overload
- Fix `inputJsonSchema` / `outputJsonSchema` to store the final JSON object (call `.jsonSchema.input()` at construction time)
- Fix `register()` to call `deps.server.registerTool()` with the correct four-argument form: `(name, description, inputSchema, handler)` — matching how `tool-execution.ts` calls it
- Export types: `Annotation`, `TaskMode`, `ToolCtx`, `ToolDeps`, `ToolDef`

- [ ] **Step 1: Read the files you need to understand before editing**

Read: `src/tools/define.ts`, `src/tools/progress-sinks.ts`, `src/core/concurrency.ts` (lines 1-10 to see composeAbortSignals export), `src/core/errors.ts` (McpError overloads, lines 409-470)

Read `src/core/observability.ts` lines 749-760 to see `ProgressSessionOptions`.

Run: `npx tsc --noEmit` to verify current state.
Expected: PASS.

- [ ] **Step 2: Rewrite `src/tools/define.ts`**

Replace the entire file with the following implementation:

```typescript
/**
 * Tool definition engine.
 *
 * `defineTool()` is the single entry point for registering a tool with the MCP server.
 * It replaces the legacy 5-layer pipeline (ToolContract → defineTool → registerStandardTool
 * → wrapToolHandler → executeToolWithDiagnostics → convertSchemasToWire).
 *
 * Handler contract:
 *   - Return `z.infer<O>` directly (plain data — NOT wrapped in ToolResult).
 *   - Throw `McpError` for tool-level errors; defineTool maps them to MCP error responses.
 *   - Per-item batch errors live in the output shape; they are NOT thrown.
 */
import type {
  ElicitRequestFormParams,
  ElicitResult,
  LoggingLevel,
  McpServer,
  ProgressToken,
} from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { composeAbortSignals } from '../core/concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, McpError } from '../core/errors.js';
import type { ProgressSink } from '../core/observability.js';
import { Logger, ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';

// ---- Public types -------------------------------------------------------

export type Annotation = 'readOnly' | 'idempotentWrite' | 'destructiveWrite';
export type TaskMode = 'forbidden' | 'optional' | 'required';

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly log: (level: LoggingLevel, message: string, ctx?: string) => void;
  readonly elicit?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

export interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly orchestrator?: unknown;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
}

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly annotations: Annotation;
  readonly task?: TaskMode;
  readonly timeoutMs?: number;
  readonly progressLabel?: (args: z.infer<I>) => string;
  readonly defaultErrorCode?: ErrorCode;
  readonly run: (args: z.infer<I>, ctx: ToolCtx) => Promise<z.infer<O>>;
  readonly nuances?: readonly string[];
  readonly gotchas?: readonly string[];
}

export interface DefinedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: Annotation;
  readonly task: TaskMode;
  readonly nuances: readonly string[];
  readonly gotchas: readonly string[];
  readonly inputJsonSchema: object;
  readonly outputJsonSchema: object;
  register(deps: ToolDeps): void;
}

// ---- Annotation → MCP hints mapping ------------------------------------

const ANNOTATION_HINTS = {
  readOnly: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  idempotentWrite: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  destructiveWrite: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
} as const satisfies Record<Annotation, object>;

// ---- MCP progress sink --------------------------------------------------

interface McpProgressSinkOpts {
  progressToken: ProgressToken;
  sendNotification: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
  signal: AbortSignal;
}

class McpProgressSink implements ProgressSink {
  readonly name = 'mcp';
  readonly #token: ProgressToken;
  readonly #send: McpProgressSinkOpts['sendNotification'];
  readonly #signal: AbortSignal;

  constructor(opts: McpProgressSinkOpts) {
    this.#token = opts.progressToken;
    this.#send = opts.sendNotification;
    this.#signal = opts.signal;
  }

  async emit(event: import('../core/observability.js').ProgressEvent): Promise<void> {
    if (this.#signal.aborted) return;
    if (event.kind === 'tick') {
      await this.#send({
        method: 'notifications/progress',
        params: {
          progressToken: this.#token,
          progress: event.current,
          ...(event.total !== undefined ? { total: event.total } : {}),
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
      });
    } else if (event.kind === 'complete' || event.kind === 'fail') {
      const display = Math.max(event.current, event.total ?? event.current, 1);
      await this.#send({
        method: 'notifications/progress',
        params: {
          progressToken: this.#token,
          progress: display,
          total: display,
          ...(event.message !== undefined ? { message: event.message } : {}),
        },
      });
    }
  }
}

// ---- Registry ----------------------------------------------------------

export const ALL_TOOLS: DefinedTool[] = [];

// ---- Factory ------------------------------------------------------------

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const inputMcpSchema = toMcpSchema(def.input);
  const outputMcpSchema = toMcpSchema(def.output);
  const inputJsonSchema = inputMcpSchema.jsonSchema.input() as object;
  const outputJsonSchema = outputMcpSchema.jsonSchema.output() as object;
  const taskMode: TaskMode = def.task ?? 'forbidden';

  const tool: DefinedTool = {
    name: def.name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    task: taskMode,
    nuances: def.nuances ?? [],
    gotchas: def.gotchas ?? [],
    inputJsonSchema,
    outputJsonSchema,

    register(deps: ToolDeps): void {
      const handler = async (args: unknown, extra: unknown) => {
        if (!deps.isInitialized()) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Server not initialized. Roots unavailable.' }],
          };
        }

        // Validate input
        const parsed = def.input.safeParse(args);
        if (!parsed.success) {
          const msg = `Invalid input: ${parsed.error.message}`;
          return { isError: true, content: [{ type: 'text', text: msg }] };
        }

        // Compose abort signal + optional timeout
        const extraObj =
          typeof extra === 'object' && extra !== null ? (extra as Record<string, unknown>) : {};
        const clientSignal = extraObj.signal instanceof AbortSignal ? extraObj.signal : undefined;
        const timeoutSignal = def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined;
        const signal = composeAbortSignals(clientSignal, timeoutSignal);

        // Build progress session with MCP sink if available
        const progressToken = (extraObj._meta as Record<string, unknown> | undefined)
          ?.progressToken;
        const sendNotification =
          typeof extraObj.sendNotification === 'function'
            ? (extraObj.sendNotification as McpProgressSinkOpts['sendNotification'])
            : undefined;
        const sinks: ProgressSink[] = [];
        if (progressToken !== undefined && sendNotification !== undefined) {
          sinks.push(
            new McpProgressSink({
              progressToken: progressToken as ProgressToken,
              sendNotification,
              signal,
            }),
          );
        }
        const label = def.progressLabel ? def.progressLabel(parsed.data) : def.name;
        const progressSession = new ProgressSession({ label, sinks, dynamicRateLimit: true });

        // Build log function from MCP context
        const mcpLog =
          typeof extraObj.log === 'function'
            ? (extraObj.log as (
                level: LoggingLevel,
                message: string,
                logger?: string,
              ) => Promise<void>)
            : undefined;
        const log: ToolCtx['log'] = (level, message, ctx) => {
          Logger.emit(level, message);
          if (mcpLog) void mcpLog(level, message, ctx);
        };

        // Build elicit function if available
        const elicit =
          typeof extraObj.elicitInput === 'function'
            ? (extraObj.elicitInput as (p: ElicitRequestFormParams) => Promise<ElicitResult>)
            : undefined;

        const ctx: ToolCtx = {
          signal,
          pathGuard: deps.pathGuard,
          resourceStore: deps.resourceStore,
          log,
          ...(elicit ? { elicit } : {}),
        };

        try {
          const result = await def.run(parsed.data, ctx);
          progressSession.complete(def.name);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error: unknown) {
          progressSession.fail(error);
          const code =
            error instanceof McpError ? error.code : (def.defaultErrorCode ?? ErrorCode.UNKNOWN);
          const message =
            error instanceof McpError ? error.message : formatUnknownErrorMessage(error);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
            _meta: { errorCode: code },
          };
        }
      };

      // Register with MCP server
      // registerTool(name, description, inputSchema, handler)
      deps.server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: inputMcpSchema as never,
          outputSchema: outputMcpSchema as never,
          annotations: ANNOTATION_HINTS[def.annotations],
        },
        handler as never,
      );
    },
  };

  ALL_TOOLS.push(tool);
  return tool;
}

export function registerAllTools(deps: ToolDeps): void {
  for (const tool of ALL_TOOLS) {
    tool.register(deps);
  }
}
```

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit`
Expected: PASS (or only errors in other files not yet migrated — if `define.ts` itself is clean, proceed)

- [ ] **Step 4: Run tasks to confirm green**

Run: `npm run tasks`
Expected: All 6 tasks pass (existing tests don't yet use the new register() path, so no regressions)

- [ ] **Step 5: Commit**

```powershell
git add src/tools/define.ts
git commit -m "fix: rewrite define.ts for production correctness"
```

---

## Task 2: Migrate Simple Tools — Roots, CreateDirectory, DiffFiles

**Files:** Modify: `src/tools/roots.ts`, `src/tools/create-directory.ts`, `src/tools/diff-files.ts`

These three tools have no resource-store interactions and simple handlers — ideal first migrations.

Pattern for each tool:

1. Change `import { defineTool } from './define-tool.js'` → `import { defineTool } from './define.js'`
2. Remove `ToolContract` object
3. Move all contract fields inline into `defineTool({ name, title, description, ... })`
4. Change handler signature: `(args, ctx: HandlerContext)` → `(args, ctx: ToolCtx)`
5. Change return: `return buildToolResponse(text, data)` → `return data`
6. Change errors: `return buildToolErrorResponse(err, code)` → `throw new McpError(code, message)`
7. Change `await ctx.log?.('level', msg)` → `ctx.log('level', msg)`
8. Map `annotations` field from annotation object to string literal: `READ_ONLY_TOOL_ANNOTATIONS` → `'readOnly'`, `DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS` → `'destructiveWrite'`, `IDEMPOTENT_WRITE_TOOL_ANNOTATIONS` → `'idempotentWrite'`
9. Import `ToolCtx` from `./define.js`
10. Remove unused imports

For `diff-files.ts` specifically — it uses `runInWorker`/`shouldOffload` from concurrency; keep those imports from `../core/concurrency.js`. The handler returns a `StructuredPatch`-based output — ensure the Zod output schema matches what's currently returned.

- [ ] **Step 1: Read the three files before editing**

Read: `src/tools/roots.ts`, `src/tools/create-directory.ts`, `src/tools/diff-files.ts`

- [ ] **Step 2: Migrate `roots.ts`**

In `roots.ts`, the migration is:

- Import `{ defineTool, type ToolCtx }` from `'./define.js'`
- Import `{ z }` from `'zod/v4'`
- Remove imports of `defineTool` from `'./define-tool.js'`, `DIRECTORY_ICONS`, `buildToolResponse`, `READ_ONLY_TOOL_ANNOTATIONS`, `type ToolContract`
- Remove `LIST_ALLOWED_DIRECTORIES_TOOL` constant
- Change `defineTool<Input, Output>({ contract: ..., run: ... })` to `defineTool({ name: 'roots', ..., annotations: 'readOnly', run: (_args, ctx) => { return Promise.resolve({ ok: true as const, roots: ctx.pathGuard.getAllowedDirectories() }); } })`
- Keep the output schema and input schema inline (no separate constant needed for migration)

- [ ] **Step 3: Migrate `create-directory.ts`**

Read the file first. Map it similarly:

- `annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS` → `annotations: 'destructiveWrite'` (creating directories is destructive)
- Handler: change `buildToolResponse(...)` → `return { ok: true, path: ... }`
- Handler: change `throw new McpError(code, msg)` stays as-is

- [ ] **Step 4: Migrate `diff-files.ts`**

Read the file first. The output includes a `patch` object (StructuredPatch). Map carefully:

- Keep the `runInWorker` / `shouldOffload` usage in the handler — just change the wrapper
- Change return from `buildToolResponse(text, data)` → `return data`

- [ ] **Step 5: Run type-check**

Run: `npx tsc --noEmit`
Expected: PASS. Fix any type errors before proceeding.

- [ ] **Step 6: Run tasks**

Run: `npm run tasks`
Expected: All 6 tasks pass.

- [ ] **Step 7: Commit**

```powershell
git add src/tools/roots.ts src/tools/create-directory.ts src/tools/diff-files.ts
git commit -m "refactor: migrate roots/create-directory/diff-files to new defineTool engine"
```

---

## Task 3: Migrate Write Tools — WriteFile, MoveFile, DeleteFile

**Files:** Modify: `src/tools/write-file.ts`, `src/tools/move-file.ts`, `src/tools/delete-file.ts`

These tools use `putResource` or `buildResourceResponse`. The key migration is calling `ctx.resourceStore.set()` directly.

**Resource store API (read `src/core/store.ts` first):**
Look for the `set()` method signature on `ResourceStore`. The result has `uri`, `size`, `mimeType`, `expiresAt` fields. Use that directly.

For `write-file.ts`:

- Currently calls `putResource({ store: ctx.resourceStore, ... })` then `buildResourceResponse(...)`
- After: call `ctx.resourceStore.set(...)`, build the output object directly, `return outputObj`
- The output schema already has `resourceUri` field — populate it from the store result

For `move-file.ts` and `delete-file.ts`:

- These likely have simpler patterns without resource storage — read them first to confirm

- [ ] **Step 1: Read `src/core/store.ts` ResourceStore interface**

Look for the `set()` method. Note its parameter shape and return type.

- [ ] **Step 2: Read the three tool files**

Read: `src/tools/write-file.ts`, `src/tools/move-file.ts`, `src/tools/delete-file.ts`

- [ ] **Step 3: Migrate each file using the established pattern**

Apply migration pattern from Task 2. For `write-file.ts`, replace `putResource` + `buildResourceResponse` with `ctx.resourceStore.set()` + `return outputObj`.

- [ ] **Step 4: Run type-check + tasks**

Run: `npx tsc --noEmit` then `npm run tasks`
Expected: All pass.

- [ ] **Step 5: Commit**

```powershell
git add src/tools/write-file.ts src/tools/move-file.ts src/tools/delete-file.ts
git commit -m "refactor: migrate write/move/delete file tools to new defineTool engine"
```

---

## Task 4: Migrate Stat + Hash + Single-Read Tools

**Files:** Modify: `src/tools/stat.ts`, `src/tools/calculate-hash.ts`, `src/tools/read.ts`

- `stat.ts`: simple output, no resource store
- `calculate-hash.ts`: simple output
- `read.ts`: may use resource store for large file content (check `putResource` usage)

Follow the exact same pattern as Task 2-3.

- [ ] **Step 1: Read the three files**

- [ ] **Step 2: Migrate each file**

- [ ] **Step 3: Run type-check + tasks**

- [ ] **Step 4: Commit**

```powershell
git add src/tools/stat.ts src/tools/calculate-hash.ts src/tools/read.ts
git commit -m "refactor: migrate stat/hash/read tools to new defineTool engine"
```

---

## Task 5: Migrate Batch + Traversal Tools

**Files:** Modify: `src/tools/stat-many.ts`, `src/tools/read-multiple.ts`, `src/tools/list-directory.ts`, `src/tools/search-files.ts`, `src/tools/tree.ts`

These are medium-complexity tools. They use `processInParallel`, `batchResult`, cursor-based pagination, and progress reporting.

**Progress reporting migration:**
Current pattern:

```ts
ctx.onProgress({ current: n, total: N });
```

New pattern — `ToolCtx` has no `onProgress`. Use `ctx.log` for status updates instead, OR omit progress updates in these tools for now (they work without them).

Actually, the new `defineTool()` does create a ProgressSession in `register()`. But `ToolCtx` doesn't expose it. For Phase 2, simply remove fine-grained progress callbacks in handlers that use them — the session-level progress (start/complete/fail) is still sent automatically by the engine. Add a note in the commit message.

**Cursor migration:**
Many tools use `encodeOffsetCursor` / `decodeOffsetCursor` from `shared.ts`. These helpers must be moved to a small local `cursor.ts` utility or inlined. Check which tools share them.

- [ ] **Step 1: Read the five files + check cursor helper usage**

Read each file. Run:

```powershell
Select-String -Path src\tools\*.ts -Pattern "encodeOffsetCursor|decodeOffsetCursor|createBase64JsonCodec" | Select-Object Filename
```

- [ ] **Step 2: Create `src/tools/cursor.ts` if cursor helpers are shared**

If multiple tools use cursor encoding, extract `encodeOffsetCursor`, `decodeOffsetCursor`, and `createBase64JsonCodec` usage into `src/tools/cursor.ts` with proper exports. Reference the existing implementations in `src/tools/shared.ts`.

- [ ] **Step 3: Migrate each file**

- [ ] **Step 4: Run type-check + tasks**

- [ ] **Step 5: Commit**

```powershell
git add src/tools/stat-many.ts src/tools/read-multiple.ts src/tools/list-directory.ts src/tools/search-files.ts src/tools/tree.ts
git commit -m "refactor: migrate stat-many/read-multiple/list-dir/search-files/tree to new engine"
```

---

## Task 6: Migrate Complex Edit Tools

**Files:** Modify: `src/tools/edit-file.ts`, `src/tools/apply-patch.ts`, `src/tools/replace-in-files.ts`

These are the most complex tools (400–660 LOC). `apply-patch.ts` and `replace-in-files.ts` use `runInWorker` and batch results. `edit-file.ts` uses structural search/replace.

These use `createBatchProgressCallbacks`, `runWithProgressSession`, `completeProgressSession` from `progress-sinks.ts`. For Phase 2, these progress helpers can be inlined or removed (batch-level progress). The key invariant is: the tool still works correctly without fine-grained progress callbacks.

- [ ] **Step 1: Read all three files carefully**

Note every import from `shared.ts`, `progress-sinks.ts`, `define-tool.ts`. List all the helpers used.

- [ ] **Step 2: Check if batch progress helpers are used**

```powershell
Select-String -Path src\tools\edit-file.ts, src\tools\apply-patch.ts, src\tools\replace-in-files.ts -Pattern "createBatchProgressCallbacks|runWithProgressSession|completeProgressSession"
```

- [ ] **Step 3: Migrate each file**

Apply the migration pattern. If batch progress callbacks are removed, add a `// TODO: Phase 3 - restore batch progress` comment.

- [ ] **Step 4: Run type-check + tasks**

- [ ] **Step 5: Commit**

```powershell
git add src/tools/edit-file.ts src/tools/apply-patch.ts src/tools/replace-in-files.ts
git commit -m "refactor: migrate edit-file/apply-patch/replace-in-files to new engine"
```

---

## Task 7: Migrate `search-content.ts`

**Files:** Modify: `src/tools/search-content.ts`

This is the most complex tool (1638 LOC). It has its own worker thread (separate Worker for parallel grep). Be careful not to break the internal worker logic.

- [ ] **Step 1: Read key sections of `search-content.ts`**

Read the top 80 lines (imports and type definitions), the main `SEARCH_CONTENT` export, and the `run` handler. Focus on what imports come from `define-tool.js`, `shared.ts`, `progress-sinks.ts`.

- [ ] **Step 2: Migrate only the registration surface**

The internal grep worker is unchanged. Only the tool registration wrapper changes:

- `import { defineTool } from './define-tool.js'` → `import { defineTool } from './define.js'`
- Remove `ToolContract` constant, inline fields into `defineTool()`
- Remove `buildToolResponse(...)` wrapper → `return data`
- Change `annotations` to string literal

Keep all internal helper functions as-is. Do NOT refactor the grep logic.

- [ ] **Step 3: Run type-check + tasks**

- [ ] **Step 4: Commit**

```powershell
git add src/tools/search-content.ts
git commit -m "refactor: migrate search-content to new defineTool engine"
```

---

## Task 8: Update `src/tools.ts` and Remove Legacy Pipeline

**Files:**

- Modify: `src/tools.ts`
- Delete: `src/tools/define-tool.ts`, `src/tools/tool-execution.ts`, `src/tools/contract.ts`, `src/tools/progress-sinks.ts`, `src/tools/icons.ts`, `src/tools/shared.ts`

After all tools are migrated, the legacy pipeline is unused. This task wires `src/tools.ts` to use `ALL_TOOLS` and `registerAllTools` from `define.ts`, then removes dead files.

- [ ] **Step 1: Verify all tools are migrated**

Run: `npx tsc --noEmit`
Run: `Select-String -Path src\tools\*.ts -Pattern "from './define-tool\.js'" | Select-Object Filename`
Expected: zero matches. If any remain, migrate them before proceeding.

- [ ] **Step 2: Rewrite `src/tools.ts`**

Replace the current content with:

```typescript
/**
 * Tool registry — all tools registered here are exposed to MCP clients.
 *
 * Each tool file calls `defineTool()` at module evaluation time, which
 * auto-registers it in `ALL_TOOLS`. This file just imports the tool modules
 * (side-effect) and re-exports the registry helpers.
 */
import './tools/apply-patch.js';
import './tools/calculate-hash.js';
import './tools/create-directory.js';
import { ALL_TOOLS, registerAllTools, type ToolDeps } from './tools/define.js';
import './tools/delete-file.js';
import './tools/diff-files.js';
import './tools/edit-file.js';
import './tools/list-directory.js';
import './tools/move-file.js';
import './tools/read-multiple.js';
import './tools/read.js';
import './tools/replace-in-files.js';
// Import tool modules (side-effect: auto-registers via defineTool())
import './tools/roots.js';
import './tools/search-content.js';
import './tools/search-files.js';
import './tools/stat-many.js';
import './tools/stat.js';
import './tools/tree.js';
import './tools/write-file.js';

export { ALL_TOOLS, registerAllTools, type ToolDeps };
```

- [ ] **Step 3: Update callers of `registerAllTools` in bootstrap**

Find where `registerAllTools(server, options)` is called (in `src/server/bootstrap.ts`). Change the call to pass a single `ToolDeps` object:

```ts
registerAllTools({ isInitialized, server, pathGuard, resourceStore, orchestrator });
```

Read `src/server/bootstrap.ts` to find the exact call site and how `isInitialized`, `pathGuard`, `resourceStore` are obtained.

- [ ] **Step 4: Delete unused pipeline files**

```powershell
Remove-Item src/tools/define-tool.ts, src/tools/tool-execution.ts, src/tools/contract.ts, src/tools/progress-sinks.ts, src/tools/icons.ts
```

For `shared.ts`: check if any tool still imports from it after migration:

```powershell
Select-String -Path src\**\*.ts -Pattern "from '\.\.?/tools/shared\.js'" | Select-Object Filename
```

If no remaining imports, delete `src/tools/shared.ts`. If some remain, handle them first.

- [ ] **Step 5: Update `knip.json` if needed**

If `src/tools/shared.ts` is deleted, ensure knip doesn't error. Run `npm run tasks` and fix any knip errors.

- [ ] **Step 6: Run full tasks**

Run: `npm run tasks`
Expected: All 6 pass.

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "refactor: wire ALL_TOOLS registry and remove legacy pipeline"
```

---

## Task 9: Consolidate Server Bootstrap → `src/server.ts`

**Files:**

- CREATE: `src/server.ts` (root level, new)
- DELETE: `src/server/bootstrap.ts`, `src/server/roots-manager.ts`, `src/server/task-orchestrator.ts`, `src/server/task-store.ts`, `src/server/event-store.ts`
- MODIFY: `src/index.ts`, `src/cli.ts` — update imports from `./server/bootstrap.js` → `./server.js`

The server bootstrap is 5 files totalling ~1200 LOC. They are highly coupled: `bootstrap.ts` imports from all four others, and the others cross-reference each other. Collapsing them into one file removes the circular-import smell.

Strategy: Use namespace sections with `// ---- Section: Name ----` comments to keep the large file navigable.

Sections in `src/server.ts`:

```
// ---- Section: EventStore ----
// ---- Section: TaskStore ----
// ---- Section: TaskOrchestrator ----
// ---- Section: RootsManager ----
// ---- Section: Bootstrap (createMcpServer, startStdio, startHttp) ----
```

- [ ] **Step 1: Read all 5 server files**

Read: `src/server/bootstrap.ts`, `src/server/roots-manager.ts`, `src/server/task-orchestrator.ts`, `src/server/task-store.ts`, `src/server/event-store.ts`

Note all public exports needed by callers outside `src/server/`.

- [ ] **Step 2: Find all external callers of server files**

```powershell
Select-String -Path src\*.ts, __tests__\**\*.ts -Pattern "from '.*server/(?!bootstrap).*'" | Select-Object Line, Filename
```

Also check:

```powershell
Select-String -Path src\*.ts, __tests__\**\*.ts -Pattern "from '.*server/" | Select-Object Line, Filename
```

- [ ] **Step 3: Create `src/server.ts`**

Concatenate all 5 server files into one, with section headers, resolving internal cross-references:

- Inline imports (remove relative `../server/X` imports between them)
- Maintain all public exports using `export` keyword
- Keep the same logic — this is a consolidation, not a rewrite

The resulting file will be ~1200 LOC. That's acceptable for a server bootstrap file.

- [ ] **Step 4: Update `src/index.ts` and `src/cli.ts`**

Any imports like `from './server/bootstrap.js'` → `from './server.js'`
Any imports like `from './server/roots-manager.js'` → `from './server.js'`

- [ ] **Step 5: Update test imports**

Check `__tests__/` for any imports from server sub-files and update to `'../../src/server.js'`.

- [ ] **Step 6: Delete the `src/server/` folder**

```powershell
Remove-Item src/server -Recurse -Force
```

- [ ] **Step 7: Run type-check + tasks**

Run: `npx tsc --noEmit` then `npm run tasks`
Expected: All pass.

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "refactor: consolidate server bootstrap into src/server.ts"
```

---

## Task 10: Consolidate Resources → `src/resources.ts`

**Files:**

- MODIFY: `src/resources.ts` (root level, already exists — augment it)
- DELETE: `src/resources/contract.ts`, `src/resources/filesystem.ts`, `src/resources/instructions.ts`, `src/resources/result.ts`, `src/resources/shared.ts`

The root-level `src/resources.ts` already exists but currently imports from `src/resources/`. This task inlines all the sub-files into `src/resources.ts` directly.

- [ ] **Step 1: Read `src/resources.ts` and all 5 sub-files**

Read: `src/resources.ts`, `src/resources/contract.ts`, `src/resources/filesystem.ts`, `src/resources/instructions.ts`, `src/resources/result.ts`, `src/resources/shared.ts`

Note the LOC totals and all public exports that callers depend on.

- [ ] **Step 2: Inline sub-file content into `src/resources.ts`**

Replace `import from './resources/X.js'` with the actual code from those files. Order: shared → contract → instructions → filesystem → result → main registration logic.

- [ ] **Step 3: Delete the `src/resources/` folder**

```powershell
Remove-Item src/resources -Recurse -Force
```

- [ ] **Step 4: Run type-check + tasks**

Run: `npm run tasks`
Expected: All pass.

- [ ] **Step 5: Commit**

```powershell
git add -A
git commit -m "refactor: consolidate resources into src/resources.ts"
```

---

## Final Verification

After all tasks:

```powershell
npm run tasks
```

Expected output:

```
✔  format
✔  knip
✔  type-check
✔  lint
✔  rebuild
✔  test
✔  6/6 passed
```

Then check file counts:

```powershell
(Get-ChildItem src -Recurse -Filter *.ts | Where-Object { !$_.Name.EndsWith('.d.ts') }).Count
```

Expected: ~22 files (down from ~56) per design spec section 3.1.
