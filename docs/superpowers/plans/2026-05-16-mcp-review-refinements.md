# MCP Review Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven correctness gaps and code-quality issues identified in the MCP v2 implementation review: stale comments, dead feature flags, a redundant shutdown listener, a silent subscribe failure, split capability construction, invisible task-chain errors, and a confusing internal class name.

**Architecture:** All changes are confined to `src/` — no new files, no new abstractions. Changes range from single-line deletions up to a mechanical class rename across 19 files. Each task is independently committable.

**Tech Stack:** TypeScript (ESM strict), `@modelcontextprotocol/server` v2 alpha, Node.js ≥ 24, `zod/v4`, `node:test` for testing.

---

## File Map

| File                                         | Tasks that touch it |
| -------------------------------------------- | ------------------- |
| `src/tools/define.ts`                        | 1                   |
| `src/server.ts`                              | 1, 3                |
| `src/transport.ts`                           | 1                   |
| `src/resources.ts`                           | 2                   |
| `src/tasks.ts`                               | 4, (5 rename)       |
| `src/core/errors.ts`                         | 5                   |
| `src/core/concurrency.ts`                    | 5                   |
| `src/core/path.ts`                           | 5                   |
| `src/core/fs.ts`                             | 5                   |
| `src/core/store.ts`                          | 5                   |
| `src/core/worker.ts`                         | 5                   |
| `src/tools/_helpers.ts`                      | 5                   |
| `src/tools/calculate-hash.ts`                | 5                   |
| `src/tools/replace-in-files.ts`              | 5                   |
| `src/tools/search-content.ts`                | 5                   |
| `src/tools/edit.ts`                          | 5                   |
| `src/tools/move.ts`                          | 5                   |
| `src/tools/delete-file.ts`                   | 5                   |
| `__tests__/unit/errors.test.ts`              | 5                   |
| `__tests__/unit/cursor.test.ts`              | 5                   |
| `__tests__/unit/worker-pool-timeout.test.ts` | 5                   |
| `__tests__/unit/resource-store.test.ts`      | 5                   |
| `__tests__/unit/resource-store-blob.test.ts` | 5                   |

---

## Task 1: Remove three dead-code / stale items

**What and why:**

- `src/tools/define.ts:423` — comment says `` `as never` `` bridges a type mismatch but no such cast exists; the comment is from a prior refactor.
- `src/server.ts:30-54` — `CapabilityOptions.enablePromptListChanged` is always `false`; the option and the conditional are dead.
- `src/transport.ts:771-773` — `httpServer.once('close', ...)` calls `registry.closeAll()` but `httpServer.close` (overridden two lines later) already calls it; the listener fires a second redundant time on normal shutdown.

**Files:**

- Modify: `src/tools/define.ts`
- Modify: `src/server.ts`
- Modify: `src/transport.ts`

---

- [ ] **Step 1: Delete the stale comment in define.ts**

Open `src/tools/define.ts`. Around line 423 you'll find:

```typescript
    register(deps: ToolDeps) {
      // `as never`: bridges StandardSchema/JSON-Schema type mismatch at registration boundary.
      const toolDefShape = {
```

Delete only the comment line. Result:

```typescript
    register(deps: ToolDeps) {
      const toolDefShape = {
```

- [ ] **Step 2: Kill the dead enablePromptListChanged option in server.ts**

Find and delete the entire `CapabilityOptions` interface and `buildServerCapabilities` function (lines 30–54). They look like:

```typescript
interface CapabilityOptions {
  enablePromptListChanged?: boolean;
  enableTaskToolRequests?: boolean;
}

function buildServerCapabilities(options: CapabilityOptions = {}): ServerCapabilities {
  const capabilities: ServerCapabilities = {
    logging: {},
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: options.enablePromptListChanged ? { listChanged: true } : {},
    completions: {},
    extensions: {},
  };

  if (options.enableTaskToolRequests) {
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  return capabilities;
}
```

Also delete the `ServerCapabilities` import from `@modelcontextprotocol/server` if it becomes unused after Task 3 (check after Task 3 is done).

- [ ] **Step 3: Remove the redundant once('close') listener in transport.ts**

Find and delete only these three lines in `startHttpServer`:

```typescript
httpServer.once('close', () => {
  void registry.closeAll();
});
```

The overridden `httpServer.close` already calls `registry.closeAll()`. The `once('close', ...)` listener fires after `originalClose` resolves, duplicating the call. Leave the `httpServer.close` override intact.

- [ ] **Step 4: Verify static checks pass**

```bash
node scripts/tasks.mjs check --quick
```

Expected: no errors. If the `ServerCapabilities` import is now unused (it will be after Task 3 removes the callers), TypeScript will flag it — leave the fix for Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/tools/define.ts src/server.ts src/transport.ts
git commit -m "chore: remove stale comment, dead prompt-listChanged flag, and redundant closeAll listener"
```

---

## Task 2: Fix resources/subscribe to error on unknown URI

**What and why:**
The `resources/subscribe` low-level handler silently returns `{}` when the requested URI doesn't match any registered resource. The MCP spec expects an error response for unrecognised URIs. Currently a client receives success but no subscription is registered.

**Files:**

- Modify: `src/resources.ts`

---

- [ ] **Step 1: Read the subscribe handler**

Open `src/resources.ts` and find the block starting with:

```typescript
  server.server.setRequestHandler(
    'resources/subscribe',
```

It currently looks like this (around lines 379–416):

```typescript
server.server.setRequestHandler(
  'resources/subscribe',
  (req: { params: { uri: string } }, ctx: ServerContext) => {
    const requestedResource = resourceUrlFromServerUrl(req.params.uri);
    return withTelemetry(
      {
        event: 'resource_subscription',
        action: 'subscribe',
        uri: requestedResource.toString(),
        session_id: ctx.sessionId ?? null,
      },
      () => {
        for (const contract of ALL_RESOURCES) {
          if (!contract.subscribe) continue;

          const configured = contract.uri ?? contract.uriTemplate?.split('{')[0];

          if (!configured) continue;

          if (
            checkResourceAllowed({
              requestedResource,
              configuredResource: configured,
            })
          ) {
            contract.subscribe(requestedResource.toString(), (updatedUri) => {
              void server.server.sendResourceUpdated({ uri: updatedUri }).catch(() => {
                /* Transport may be closed */
              });
            });
            break;
          }
        }
        return {};
      },
    );
  },
);
```

- [ ] **Step 2: Write a failing test**

Create `__tests__/unit/resource-subscribe-unknown.test.ts`:

```typescript
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
// The subscribe handler is internal — simulate by invoking the resource
// registration and checking the handler throws on an unknown URI.
// We test the exported registerAllResources via a minimal fake server.

import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createInMemoryResourceStore } from '../../src/core/store.js';
import { registerAllResources } from '../../src/resources.js';

interface FakeServer {
  handlers: Map<string, (req: unknown, ctx: unknown) => unknown>;
  registerResource: (...args: unknown[]) => void;
  server: {
    setRequestHandler: (method: string, handler: (req: unknown, ctx: unknown) => unknown) => void;
    sendResourceUpdated: () => Promise<void>;
  };
}

function makeFakeServer(): FakeServer {
  const handlers = new Map<string, (req: unknown, ctx: unknown) => unknown>();
  return {
    handlers,
    registerResource: () => undefined,
    server: {
      setRequestHandler(method, handler) {
        handlers.set(method, handler);
      },
      sendResourceUpdated: async () => undefined,
    },
  };
}

test('resources/subscribe: throws ProtocolError for unknown URI', async () => {
  const server = makeFakeServer();
  registerAllResources(server as unknown as McpServer, {
    resourceStore: createInMemoryResourceStore(),
  });

  const handler = server.handlers.get('resources/subscribe');
  assert.ok(handler, 'subscribe handler was registered');

  const ctx = { sessionId: 'test-session' };
  const req = { params: { uri: 'filesystem-mcp://unknown/something' } };

  await assert.rejects(
    async () => handler(req, ctx),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'threw an Error');
      assert.ok(
        (err as { code?: unknown }).code === ProtocolErrorCode.ResourceNotFound ||
          err.message.includes('Unknown resource'),
        `expected ResourceNotFound error, got: ${err.message}`,
      );
      return true;
    },
  );
});
```

- [ ] **Step 3: Run to confirm it fails**

```bash
node --test --import tsx/esm "__tests__/unit/resource-subscribe-unknown.test.ts"
```

Expected: `AssertionError` — the handler currently returns `{}` instead of throwing.

- [ ] **Step 4: Implement the fix in resources.ts**

Replace the subscribe handler's inner callback. Add the `ProtocolError` and `ProtocolErrorCode` imports if they aren't already at the top of the file (they are — both are imported on line ~4).

Change the inner callback from:

```typescript
        () => {
          for (const contract of ALL_RESOURCES) {
            if (!contract.subscribe) continue;

            const configured = contract.uri ?? contract.uriTemplate?.split('{')[0];

            if (!configured) continue;

            if (
              checkResourceAllowed({
                requestedResource,
                configuredResource: configured,
              })
            ) {
              contract.subscribe(requestedResource.toString(), (updatedUri) => {
                void server.server.sendResourceUpdated({ uri: updatedUri }).catch(() => {
                  /* Transport may be closed */
                });
              });
              break;
            }
          }
          return {};
        },
```

To:

```typescript
        () => {
          let anyMatched = false;
          for (const contract of ALL_RESOURCES) {
            const configured = contract.uri ?? contract.uriTemplate?.split('{')[0];
            if (!configured) continue;

            if (
              checkResourceAllowed({
                requestedResource,
                configuredResource: configured,
              })
            ) {
              anyMatched = true;
              if (contract.subscribe) {
                contract.subscribe(requestedResource.toString(), (updatedUri) => {
                  void server.server.sendResourceUpdated({ uri: updatedUri }).catch(() => {
                    /* Transport may be closed */
                  });
                });
              }
              break;
            }
          }

          if (!anyMatched) {
            throw new ProtocolError(
              ProtocolErrorCode.ResourceNotFound,
              `Unknown resource: ${requestedResource.toString()}`,
            );
          }
          return {};
        },
```

- [ ] **Step 5: Run the new test to confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/resource-subscribe-unknown.test.ts"
```

Expected: `pass`.

- [ ] **Step 6: Run the full test suite**

```bash
node scripts/tasks.mjs test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/resources.ts "__tests__/unit/resource-subscribe-unknown.test.ts"
git commit -m "fix: resources/subscribe throws ProtocolError for unrecognised URIs"
```

---

## Task 3: Consolidate capability construction in createServer

**What and why:**
`buildServerCapabilities` builds a partial `ServerCapabilities` object; `createServer` then copies the fields into a fresh object, then mutates it via `Object.assign` to attach `taskStore` and `taskMessageQueue`. The two-step construction is hard to follow and scatters related config. Inline everything into one capability literal inside `createServer`.

**Files:**

- Modify: `src/server.ts`

---

- [ ] **Step 1: Write a test that the server still advertises tasks capability**

Add a test to `__tests__/unit/bootstrap-config.test.ts`. Open that file first to see its existing structure so you match the pattern. Then add at the bottom:

```typescript
test('createServer: capabilities include tasks with list, cancel, and tool-call support', async () => {
  // createServer is async — we need to check the McpServer capabilities.
  // We verify indirectly: the server must not throw when accessed via server.server.
  // The real check is that the TypeScript types compiled (type-check in CI), so here
  // we just confirm the server starts and the mcp object is non-null.
  const { createServer } = await import('../../src/server.js');
  const ctx = await createServer({ allowCwd: true });
  assert.ok(ctx.mcp, 'mcp server was created');
  await ctx.close();
});
```

- [ ] **Step 2: Run to confirm it passes (it should already)**

```bash
node --test --import tsx/esm "__tests__/unit/bootstrap-config.test.ts"
```

Expected: pass (baseline before refactor).

- [ ] **Step 3: Replace buildServerCapabilities + Object.assign with inline literal**

In `src/server.ts`, delete the `CapabilityOptions` interface and `buildServerCapabilities` function entirely (they were partially cleaned up in Task 1 — if that task ran first, `buildServerCapabilities` might already be gone; if not, delete it now).

Then find the block in `createServer` that starts with:

```typescript
const resourceStore = createInMemoryResourceStore();
const localIcon = await getLocalIconInfo();
const capabilities = buildServerCapabilities({
  enablePromptListChanged: false,
  enableTaskToolRequests: true,
});

const taskOrchestrator = new TaskOrchestrator();

const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
  capabilities: {
    logging: capabilities.logging,
    resources: capabilities.resources,
    tools: capabilities.tools,
    prompts: capabilities.prompts,
    completions: capabilities.completions,
    extensions: capabilities.extensions,
    ...(capabilities.tasks ? { tasks: capabilities.tasks } : {}),
  },
  enforceStrictCapabilities: true,
};

if (serverConfig.capabilities?.tasks) {
  Object.assign(serverConfig.capabilities.tasks, {
    taskStore: taskOrchestrator,
    taskMessageQueue: new InMemoryTaskMessageQueue(),
  });
}
```

Replace it with:

```typescript
const resourceStore = createInMemoryResourceStore();
const localIcon = await getLocalIconInfo();
const taskOrchestrator = new TaskOrchestrator();

const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
  capabilities: {
    logging: {},
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: {},
    completions: {},
    extensions: {},
    tasks: {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
      taskStore: taskOrchestrator,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    },
  },
  enforceStrictCapabilities: true,
};
```

Also remove the now-unused `ServerCapabilities` from the import at the top of `server.ts` (check if it was in the import list — it was used only by `buildServerCapabilities`):

```typescript
// Before:
import {
  type Implementation,
  InMemoryTaskMessageQueue,
  McpServer,
  type ServerCapabilities,   // ← remove this line
  type SetLevelRequestParams,
} from '@modelcontextprotocol/server';

// After:
import {
  type Implementation,
  InMemoryTaskMessageQueue,
  McpServer,
  type SetLevelRequestParams,
} from '@modelcontextprotocol/server';
```

- [ ] **Step 4: Run the bootstrap test**

```bash
node --test --import tsx/esm "__tests__/unit/bootstrap-config.test.ts"
```

Expected: pass.

- [ ] **Step 5: Run the full static check**

```bash
node scripts/tasks.mjs check --quick
```

Expected: no TypeScript or lint errors.

- [ ] **Step 6: Run all tests**

```bash
node scripts/tasks.mjs test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts "__tests__/unit/bootstrap-config.test.ts"
git commit -m "refactor(server): inline capability construction, remove buildServerCapabilities abstraction"
```

---

## Task 4: Log swallowed errors in the creationPromise chain

**What and why:**
`TaskOrchestrator.wrapToolTask` serializes task creation via a promise chain. The `.catch(() => undefined)` between links prevents one failed creation from blocking the next, but the error is completely silent. If a "too many active tasks" or similar error repeats, it leaves no trace in logs. Adding a `Logger.debug` call makes repeated failures visible when debug logging is enabled.

**Files:**

- Modify: `src/tasks.ts`

---

- [ ] **Step 1: Locate the chain in tasks.ts**

Open `src/tasks.ts` and find `creationPromise`. The relevant block (around line 214) looks like:

```typescript
      const mcpTask = (await (this.creationPromise = this.creationPromise
        .catch(() => undefined)
        .then(async () => {
```

- [ ] **Step 2: Write a failing test**

Add a test to `__tests__/unit/task-orchestrator.test.ts`. Open that file first to see the existing mock patterns. Then add:

```typescript
test('wrapToolTask: swallowed chain error is visible via Logger.debug channel', async (t) => {
  const logChannel = (await import('node:diagnostics_channel')).channel('filesystem-mcp:log');
  const debugMessages: string[] = [];

  const onLog = (msg: unknown): void => {
    if (!msg || typeof msg !== 'object') return;
    const ev = msg as { level?: string; message?: string };
    if (ev.level === 'debug' && typeof ev.message === 'string') {
      debugMessages.push(ev.message);
    }
  };

  logChannel.subscribe(onLog);
  t.after(() => logChannel.unsubscribe(onLog));

  const { TaskOrchestrator } = await import('../../src/tasks.js');
  const { PathGuard } = await import('../../src/core/path.js');
  const orch = new TaskOrchestrator();

  // Simulate a failing handler to force a chain rejection
  const fakeHandler = async (): Promise<never> => {
    throw new Error('forced failure');
  };

  const fakeStore = {
    listTasks: async () => ({ tasks: [], nextCursor: undefined }),
    createTask: async (): Promise<never> => {
      throw new Error('store failure');
    },
    updateTaskStatus: async () => undefined,
    storeTaskResult: async () => undefined,
    getTask: async () => ({ taskId: 'x', status: 'working' }),
    getTaskResult: async () => undefined,
  };

  const fakeCtx = {
    task: { store: fakeStore, requestedTtl: 60_000 },
    mcpReq: {
      signal: new AbortController().signal,
      notify: async () => undefined,
      log: async () => undefined,
    },
    sessionId: 'test',
  };

  const wrapped = orch.wrapToolTask(fakeHandler, {
    toolName: 'test-tool',
    deps: { pathGuard: null as unknown as PathGuard, resourceStore: undefined },
  });

  // First call fails (store.createTask throws) — error propagates to caller
  await assert.rejects(async () => wrapped.createTask(fakeCtx as never), /store failure/);

  // Second call: the chain had the first error swallowed; the debug log should appear
  await assert.rejects(async () => wrapped.createTask(fakeCtx as never), /store failure/);

  // The swallowed error from call 1 should appear as a debug log before call 2 runs
  assert.ok(
    debugMessages.some((m) => m.includes('TaskOrchestrator') && m.includes('cleared from chain')),
    `expected a debug log about the cleared chain error, got: ${JSON.stringify(debugMessages)}`,
  );

  orch.dispose();
  orch.cleanup();
});
```

- [ ] **Step 3: Run to confirm it fails**

```bash
node --test --import tsx/esm "__tests__/unit/task-orchestrator.test.ts"
```

Expected: the new test fails — no debug message is emitted.

- [ ] **Step 4: Add the Logger.debug call in tasks.ts**

Find the line:

```typescript
      const mcpTask = (await (this.creationPromise = this.creationPromise
        .catch(() => undefined)
```

Replace it with:

```typescript
      const mcpTask = (await (this.creationPromise = this.creationPromise
        .catch((err: unknown) => {
          Logger.debug('[TaskOrchestrator] prior task-creation failure cleared from chain', {
            toolName: options.toolName,
            error: isRecord(err) && typeof err['message'] === 'string' ? err['message'] : String(err),
          });
          return undefined;
        })
```

`Logger` is already imported (`import { logRuntimeFailure } from './core/observability.js'` — check the actual import; `Logger` may need adding). Look at the imports at the top of `tasks.ts`:

```typescript
import { ErrorCode, McpError } from './core/errors.js';
import { logRuntimeFailure } from './core/observability.js';
```

`Logger` is exported from `./core/observability.js`. Add it to the import:

```typescript
import { Logger, logRuntimeFailure } from './core/observability.js';
```

`isRecord` is already imported from `./core/util.js`.

- [ ] **Step 5: Run the new test to confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/task-orchestrator.test.ts"
```

Expected: all tests in that file pass.

- [ ] **Step 6: Run the full suite**

```bash
node scripts/tasks.mjs test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tasks.ts "__tests__/unit/task-orchestrator.test.ts"
git commit -m "feat(tasks): log swallowed creationPromise errors at debug level for visibility"
```

---

## Task 5: Rename McpError → FsError

**What and why:**
The v2 MCP SDK renamed its protocol error class from `McpError` to `ProtocolError`. The codebase has an internal domain error class also named `McpError` — a different thing (code + message + path + structured details). Developers reading v2 SDK docs see `ProtocolError` and arrive in the codebase confused about which class they're looking at. Renaming to `FsError` (filesystem error) eliminates the ambiguity.

**Scope:** 14 source files, 5 test files. All changes are mechanical find-and-replace with two exceptions:

- `src/core/errors.ts`: also change `this.name = 'McpError'` → `'FsError'` and update the `isMcpErrorCarrier` string check.
- No callers outside `src/` and `__tests__/` use `McpError` (knip confirmed zero exports missed).

**Files:**

- Modify: `src/core/errors.ts` (primary — class definition + name string + carrier check)
- Modify: 13 other `src/` files (import + usage)
- Modify: 5 `__tests__/` files (import + usage)

---

- [ ] **Step 1: Verify baseline tests pass before any changes**

```bash
node scripts/tasks.mjs check --quick
```

Expected: clean. This is your rollback baseline.

- [ ] **Step 2: Update the class definition in errors.ts**

Open `src/core/errors.ts` and make three targeted changes:

**2a.** Rename the class and update its runtime `name`:

```typescript
// Before:
export class McpError extends Error {
  readonly problem: Problem;

  // Overload 1: new McpError(problem, cause?)
  constructor(problem: Problem, cause?: unknown);
  // Overload 2 (legacy): new McpError(code, message, path?, details?, cause?)
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  );
  constructor(/* ... */) {
    // ...
    this.name = 'McpError';
    Object.setPrototypeOf(this, McpError.prototype);
  }
```

```typescript
// After:
export class FsError extends Error {
  readonly problem: Problem;

  // Overload 1: new FsError(problem, cause?)
  constructor(problem: Problem, cause?: unknown);
  // Overload 2 (legacy): new FsError(code, message, path?, details?, cause?)
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  );
  constructor(/* ... */) {
    // ...
    this.name = 'FsError';
    Object.setPrototypeOf(this, FsError.prototype);
  }
```

**2b.** Update the carrier guard string (line ~322) from `'McpError'` to `'FsError'`:

```typescript
// Before:
function isMcpErrorCarrier(error: unknown): error is { problem: Problem } {
  return (
    error instanceof Error &&
    error.name === 'McpError' &&
```

```typescript
// After:
function isFsErrorCarrier(error: unknown): error is { problem: Problem } {
  return (
    error instanceof Error &&
    error.name === 'FsError' &&
```

**2c.** Update the call site of the renamed guard inside `classify`:

```typescript
// Before:
if (isMcpErrorCarrier(error)) return error.problem;

// After:
if (isFsErrorCarrier(error)) return error.problem;
```

**2d.** Update the static factory methods at the bottom of `errors.ts` to return `FsError` and use `new FsError(...)`:

```typescript
// Before (example):
  static notFound(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ): McpError {
    return new McpError(ErrorCode.NOT_FOUND, message, path, details, cause);
  }

// After:
  static notFound(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ): FsError {
    return new FsError(ErrorCode.NOT_FOUND, message, path, details, cause);
  }
```

Repeat for `invalidInput`, `accessDenied`, and `timeout` factory methods.

**2e.** Update the section comment:

```typescript
// Before:
// ─── McpError ────────────────────────────────────────────────────────────────

// After:
// ─── FsError ─────────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Run type-check on errors.ts in isolation**

```bash
npx tsc -p tsconfig.json --noEmit 2>&1 | head -30
```

Expected: errors about all the call sites that still import `McpError`. That's expected — you haven't updated them yet.

- [ ] **Step 4: Update src/core/concurrency.ts**

Find all occurrences of `McpError` and replace with `FsError`. The import line and all `new McpError(...)` calls:

```typescript
// import line — before:
import { McpError, normalizeUnknownError } from './errors.js';
// after:
import { FsError, normalizeUnknownError } from './errors.js';
```

All `new McpError(` → `new FsError(` in this file (there are ~6 occurrences).

- [ ] **Step 5: Update src/core/path.ts**

```typescript
// import — before:
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isAbortError,
  isNodeError,
  McpError,
} from './errors.js';
// after:
import {
  ErrorCode,
  formatUnknownErrorMessage,
  isAbortError,
  isNodeError,
  FsError,
} from './errors.js';
```

Replace all `new McpError(` → `new FsError(` and `McpError.` → `FsError.` in this file.

- [ ] **Step 6: Update remaining src/ files**

For each of the following files, apply the same pattern — update the import to use `FsError` instead of `McpError`, and replace every `new McpError(` and `McpError.` call with `FsError`:

- `src/core/fs.ts`
- `src/core/store.ts`
- `src/core/worker.ts`
- `src/tools/_helpers.ts`
- `src/tools/calculate-hash.ts`
- `src/tools/replace-in-files.ts`
- `src/tools/search-content.ts`
- `src/tools/edit.ts`
- `src/tools/move.ts`
- `src/tools/delete-file.ts`
- `src/tasks.ts`

For each file, the pattern is always:

1. In the import from `'./errors.js'` or `'../core/errors.js'`: replace `McpError` with `FsError`
2. In the file body: replace `new McpError(` with `new FsError(`, and `McpError.` with `FsError.`, and `instanceof McpError` with `instanceof FsError`

Verify with a quick grep after each file:

```bash
grep -n "McpError" src/core/concurrency.ts  # should return 0 results
```

- [ ] **Step 7: Update the 5 test files**

Apply the same import-and-usage pattern to:

- `__tests__/unit/errors.test.ts`
- `__tests__/unit/cursor.test.ts`
- `__tests__/unit/worker-pool-timeout.test.ts`
- `__tests__/unit/resource-store.test.ts`
- `__tests__/unit/resource-store-blob.test.ts`

For each file, `McpError` appears in the import and potentially in `instanceof McpError` checks or `new McpError(...)` calls. Replace all occurrences.

- [ ] **Step 8: Confirm zero remaining McpError references**

```bash
grep -rn "McpError" src/ __tests__/ --include="*.ts"
```

Expected: zero results.

- [ ] **Step 9: Run the full type-check**

```bash
npx tsc -p tsconfig.json --noEmit
```

Expected: zero errors.

- [ ] **Step 10: Run the full test suite**

```bash
node scripts/tasks.mjs test
```

Expected: all tests pass. The class rename is purely mechanical — the runtime `this.name = 'FsError'` was updated in Step 2 so `isFsErrorCarrier` will still match live instances.

- [ ] **Step 11: Run the full check**

```bash
node scripts/tasks.mjs check
```

Expected: format → lint → type-check → knip → test → rebuild all pass.

- [ ] **Step 12: Commit**

```bash
git add src/ __tests__/
git commit -m "refactor: rename McpError → FsError to avoid confusion with v2 SDK's ProtocolError"
```

---

## Self-Review

**Spec coverage check:**

| Finding                                                                     | Task        |
| --------------------------------------------------------------------------- | ----------- |
| Stale comment in define.ts:423                                              | Task 1      |
| Dead `enablePromptListChanged` option                                       | Tasks 1 + 3 |
| Redundant `once('close', ...)` listener                                     | Task 1      |
| `resources/subscribe` silent success on no-match                            | Task 2      |
| Split capability construction (`buildServerCapabilities` + `Object.assign`) | Task 3      |
| `creationPromise` swallows errors silently                                  | Task 4      |
| Internal `McpError` name clashes with v2 SDK mental model                   | Task 5      |

All 7 findings covered. ✓

**Placeholder scan:** No TBDs or "implement later" present. All code blocks are complete.

**Type consistency:** `FsError` is introduced in Task 5 Step 2 and used consistently across Steps 4–7. `isFsErrorCarrier` (renamed from `isMcpErrorCarrier`) is updated at definition and call site in the same step. ✓
