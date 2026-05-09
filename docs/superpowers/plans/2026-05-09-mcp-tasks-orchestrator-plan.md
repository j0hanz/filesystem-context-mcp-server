# Task Orchestrator Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify and robustify MCP task execution by centralizing background execution and cancellation logic into a `TaskOrchestrator` class and using an event-driven task store.

**Architecture:** We will replace the polling-based cancellation mechanism with an `EventedTaskStore` that emits `'cancelled'` events. A new `TaskOrchestrator` class will manage background task execution and automatically abort running tasks using a `Map<string, AbortController>`. Tool handlers will be simplified by removing task-specific context (`TaskToolContext`) and executing purely based on `ToolContext`. `tool-execution.ts` will be stripped down to a routing layer.

**Tech Stack:** TypeScript, MCP SDK, Node.js (`node:events`, `AbortController`).

---

## Task 1: Create `EventedTaskStore`

**Files:**

- Create/Modify: `src/server/task-store.ts`
- Modify: `__tests__/unit/task-store.test.ts`

- [ ] **Step 1: Write the failing test for EventedTaskStore**

Modify `__tests__/unit/task-store.test.ts` to test event emission:

```typescript
// Add near the top: import { once } from 'node:events';
test('EventedTaskStore emits cancelled event on status update', async () => {
  const store = new EventedTaskStore();
  const task = await store.createTask({});

  const eventPromise = once(store, 'cancelled');
  await store.updateTaskStatus(task.taskId, 'cancelled');

  const [taskId] = await eventPromise;
  assert.strictEqual(taskId, task.taskId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx/esm __tests__/unit/task-store.test.ts`
Expected: FAIL due to `EventedTaskStore` not being defined.

- [ ] **Step 3: Write minimal implementation**

Modify `src/server/task-store.ts`. Replace `ResultAwareInMemoryTaskStore` with `EventedTaskStore`:

```typescript
import { InMemoryTaskStore, type Result, type Task } from '@modelcontextprotocol/server';

import { EventEmitter } from 'node:events';

export class EventedTaskStore extends InMemoryTaskStore {
  public readonly events = new EventEmitter();

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
    if (status === 'cancelled') {
      this.events.emit('cancelled', taskId);
    }
  }

  // Remove all the polling/eviction/ResultAware overrides, just keep the event emission.
  // The TaskOrchestrator will handle aborted task results directly.
}

export function createTaskStore(): EventedTaskStore {
  return new EventedTaskStore();
}
```

- [ ] **Step 4: Update existing tests to match new store**

Remove tests in `__tests__/unit/task-store.test.ts` that were specifically testing `ResultAwareInMemoryTaskStore` eviction and polling overrides, keeping basic `EventedTaskStore` tests.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/task-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/task-store.ts __tests__/unit/task-store.test.ts
git commit -m "feat: replace ResultAwareInMemoryTaskStore with EventedTaskStore"
```

## Task 2: Simplify Context Types

**Files:**

- Modify: `src/tools/shared.ts`
- Modify: `src/tools/progress-sinks.ts`

- [ ] **Step 1: Remove TaskToolContext from shared.ts**

Remove `TaskToolContext` from `src/tools/shared.ts`:

```typescript
// Remove:
// export type TaskToolContext = ToolContext & { ... }
```

- [ ] **Step 2: Simplify progress-sinks.ts**

Modify `src/tools/progress-sinks.ts`. Remove `TaskStoreSink` entirely since progress reporting in tasks will be routed via standard `sendNotification` interceptors by the Orchestrator.

```typescript
// Remove TaskStoreSink class and related interfaces.
// Remove hasTaskProgress function.

export function progressSessionFromContext(
  ctx: ToolContext,
  opts: { label: string; total?: number },
): ProgressSession {
  const sinks: ProgressSink[] = [];

  if (hasMcpProgress(ctx)) {
    try {
      sinks.push(
        new McpProgressSink({
          progressToken: ctx._meta.progressToken,
          sendNotification: ctx.sendNotification,
          signal: ctx.signal,
          log: ctx.log,
        }),
      );
    } catch (error) {
      Logger.warn(
        'progress-sinks',
        `Failed to instantiate McpProgressSink: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return new ProgressSession({
    label: opts.label,
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    sinks,
    dynamicRateLimit: true,
  });
}
```

- [ ] **Step 3: Run static checks**

Run: `node scripts/tasks.mjs --quick`
Expected: Type errors in `tool-execution.ts` and `progress-sinks.test.ts`. This is expected as we haven't updated `tool-execution.ts` yet.

- [ ] **Step 4: Commit**

```bash
git add src/tools/shared.ts src/tools/progress-sinks.ts
git commit -m "refactor: simplify ToolContext and remove TaskStoreSink"
```

## Task 3: Create TaskOrchestrator

**Files:**

- Create: `src/server/task-orchestrator.ts`
- Create: `__tests__/unit/task-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import assert from 'node:assert';
import test from 'node:test';

import { TaskOrchestrator } from '../../src/server/task-orchestrator.js';
import { EventedTaskStore } from '../../src/server/task-store.js';
import type { ToolContext } from '../../src/tools/shared.js';

test('TaskOrchestrator runs tool and handles cancellation', async () => {
  const store = new EventedTaskStore();
  const orchestrator = new TaskOrchestrator(store);

  let aborted = false;
  const mockTool = async (args: any, ctx: ToolContext) => {
    ctx.signal?.addEventListener('abort', () => {
      aborted = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    return { content: [{ type: 'text', text: 'ok' }] };
  };

  const handler = orchestrator.wrapToolTask(mockTool, { toolName: 'test' });
  const serverCtx: any = { task: { store, id: '1' } };

  const createRes = await handler.createTask({}, serverCtx);
  await store.updateTaskStatus(createRes.task.taskId, 'cancelled');

  await new Promise((r) => setTimeout(r, 150)); // wait for background task to end
  assert.strictEqual(aborted, true);

  const getRes = await handler.getTaskResult({}, {
    task: { store, id: createRes.task.taskId },
  } as any);
  assert.strictEqual(getRes.isError, true);
});
```

- [ ] **Step 2: Write implementation**

Create `src/server/task-orchestrator.ts`:

```typescript
import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  RequestTaskStore,
  Result,
  TaskServerContext,
  ToolTaskHandler,
} from '@modelcontextprotocol/server';

import { ErrorCode } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';

import type { ToolContext, ToolResult } from '../tools/shared.js';
import { maybeStripStructuredContentFromResult } from '../tools/tool-execution.js';
import type { EventedTaskStore } from './task-store.js';

export class TaskOrchestrator {
  private controllers = new Map<string, AbortController>();

  constructor(private store: EventedTaskStore) {
    this.store.events.on('cancelled', (taskId: string) => {
      const controller = this.controllers.get(taskId);
      if (controller) {
        controller.abort(new Error('Task cancelled by client'));
      }
    });
  }

  wrapToolTask<Args, R>(
    run: (args: Args, ctx: ToolContext) => Promise<ToolResult<R>>,
    options: { toolName: string; guard?: () => boolean },
  ): ToolTaskHandler<any> {
    return {
      createTask: async (args: any, serverCtx: any): Promise<CreateTaskResult> => {
        if (options.guard && !options.guard()) {
          throw new Error('Client not initialized');
        }

        const taskStore: RequestTaskStore = serverCtx.task?.store;
        if (!taskStore) throw new Error('Task store missing');

        const task = await taskStore.createTask({ ttl: 300000 });
        const controller = new AbortController();
        this.controllers.set(task.taskId, controller);

        // Run background execution
        void this.executeBackground(task.taskId, args, run, serverCtx).finally(() => {
          this.controllers.delete(task.taskId);
        });

        return { task };
      },
      getTask: async (args: any, serverCtx: any): Promise<GetTaskResult> => {
        const taskId = serverCtx.task?.id;
        if (!taskId) throw new Error('Task id missing');
        return this.store.getTask(taskId);
      },
      getTaskResult: async (args: any, serverCtx: any): Promise<CallToolResult> => {
        const taskId = serverCtx.task?.id;
        if (!taskId) throw new Error('Task id missing');
        return this.store.getTaskResult(taskId) as Promise<CallToolResult>;
      },
    };
  }

  private async executeBackground(
    taskId: string,
    args: any,
    run: (args: any, ctx: ToolContext) => Promise<ToolResult<any>>,
    serverCtx: any,
  ): Promise<void> {
    const controller = this.controllers.get(taskId)!;

    // Intercept notifications to send progress to task store
    const ctx: ToolContext = {
      signal: controller.signal,
      sendNotification: async (notif) => {
        if (notif.method === 'notifications/progress' && notif.params) {
          const p = notif.params as any;
          const message = p.message
            ? `${p.message} (${p.progress}/${p.total})`
            : `${p.progress}/${p.total}`;
          await this.store.updateTaskStatus(taskId, 'working', message);
        }
        if (serverCtx.mcpReq?.notify) await serverCtx.mcpReq.notify(notif);
      },
      log: serverCtx.mcpReq?.log.bind(serverCtx.mcpReq),
      sessionId: serverCtx.sessionId,
      _meta: serverCtx.mcpReq?._meta,
    };

    try {
      const rawResult = await run(args, ctx);
      const result = maybeStripStructuredContentFromResult(rawResult);
      await this.store.storeTaskResult(
        taskId,
        result.isError ? 'failed' : 'completed',
        result as Result,
      );
    } catch (error) {
      const result = {
        content: [
          {
            type: 'text',
            text: `Error [${ErrorCode.UNKNOWN}]: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
        errorCode: ErrorCode.UNKNOWN,
      };
      // Check if cancelled
      const status =
        controller.signal.aborted && controller.signal.reason?.message.includes('cancelled')
          ? 'cancelled'
          : 'failed';
      if (status === 'cancelled') {
        result.errorCode = ErrorCode.CANCELLED;
        result.content[0].text = `Error [${ErrorCode.CANCELLED}]: Task cancelled by client`;
      }

      await this.store.storeTaskResult(
        taskId,
        status === 'cancelled' ? 'failed' : 'failed',
        result,
      );
    }
  }
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `node --test --import tsx/esm __tests__/unit/task-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/server/task-orchestrator.ts __tests__/unit/task-orchestrator.test.ts
git commit -m "feat: implement TaskOrchestrator for background execution"
```

## Task 4: Refactor `tool-execution.ts`

**Files:**

- Modify: `src/tools/tool-execution.ts`

- [ ] **Step 1: Simplify tool-execution.ts to be a router**

Rewrite `src/tools/tool-execution.ts` to export routing logic using `TaskOrchestrator` if task support is available, stripping out all the old polling and context transformation.

```typescript
// Replace the complex background execution and polling with:
import type { McpServer, ToolTaskHandler } from '@modelcontextprotocol/server';

import type { TaskOrchestrator } from '../server/task-orchestrator.js';
import type { ToolContext, ToolContract, ToolRegistrationOptions, ToolResult } from './shared.js';

// ... standard imports and stripping helpers

export function registerStandardTool<Args, Result extends Record<string, unknown>>(
  server: McpServer,
  toolDef: ToolContract,
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions & { orchestrator?: TaskOrchestrator },
  wrapOptions: { guard?: () => boolean } = {},
): void {
  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    ...wrapOptions,
  });

  if (options.hasTaskSupport && options.orchestrator) {
    const taskHandler = options.orchestrator.wrapToolTask(wrappedHandler, {
      toolName: toolDef.name,
      guard: options.isInitialized,
    });

    if (tryRegisterToolTask(server, toolDef.name, toolDef, taskHandler)) {
      return;
    }
  }

  // Fallback to standard registration
  server.registerTool(
    toolDef.name,
    convertSchemasToWire(toolDef, toolDef.inputSchemaJson),
    wrappedHandler as never,
  );
}
```

- [ ] **Step 2: Fix type errors in compilation**

Run: `node scripts/tasks.mjs --quick`
Ensure you fix any missing imports or specific typing issues found by TypeScript in `tool-execution.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/tools/tool-execution.ts
git commit -m "refactor: strip background polling from tool-execution and use TaskOrchestrator"
```

## Task 5: Update Bootstrap

**Files:**

- Modify: `src/server/bootstrap.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Pass orchestrator through initialization**

In `src/server/bootstrap.ts` and wherever `registerStandardTool` is called, ensure `TaskOrchestrator` is instantiated with the `EventedTaskStore` and passed via `ToolRegistrationOptions`.

- [ ] **Step 2: Commit**

```bash
git add src/server/bootstrap.ts src/server.ts
git commit -m "feat: wire TaskOrchestrator into server bootstrap"
```

## Task 6: Final Type Check & Test Validation

- [ ] **Step 1: Run all tests**

Run: `node scripts/tasks.mjs`
Expected: ALL PASS. Fix any failing tests (especially in `__tests__/tools/task-mode.test.ts` or `progress-sinks.test.ts`).

- [ ] **Step 2: Final Commit**

```bash
git commit -a -m "test: update tests to match task orchestrator refactoring"
```
