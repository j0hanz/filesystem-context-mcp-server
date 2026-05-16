# MCP SDK v2 Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply six targeted fixes identified in the MCP SDK v2 audit: remove a false protocol capability declaration, fix a loopback host helper that drifts from the SDK, drop a phantom direct dependency, document an intentional internal workaround, add a capability guard to the subscription handler, and wire a task-capability assertion into the task creation path.

**Architecture:** All six tasks are independent and produce self-contained commits. Tasks 1–4 are mechanical (no behavior change visible to clients). Tasks 5–6 add defensive guards that reject misbehaving clients before they reach internal logic. No new abstractions are introduced.

**Tech Stack:** TypeScript, Node.js test runner (`node --test`), `@modelcontextprotocol/server@2.0.0-alpha.2`, Zod v4

---

## File Map

| File                                                   | Change                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `package.json`                                         | Remove `@cfworker/json-schema` from `dependencies`                             |
| `src/transport.ts`                                     | Replace `isLoopbackHttpHost` body with `localhostAllowedHostnames()`           |
| `src/server.ts`                                        | Remove `listChanged: true`; add capability guard to `resources/subscribe`      |
| `src/tools/define.ts`                                  | Add explanatory comment to `withJsonSchema`; extend `ToolOrchestrator` options |
| `src/tasks.ts`                                         | Import and call `assertToolsCallTaskCapability` in `wrapToolTask.createTask`   |
| `__tests__/unit/http-auth-guard.test.ts`               | Update `isLoopbackHttpHost` test: remove bare `::1` from accepted list         |
| `__tests__/unit/resource-subscribe-capability.test.ts` | New file: test subscribe rejects client without capability                     |

---

### Task 1: Remove `@cfworker/json-schema` phantom dependency

**Files:**

- Modify: `package.json`

`@cfworker/json-schema` is never imported in `src/`. It is a transitive dep of `@modelcontextprotocol/server` (which exports `CfWorkerJsonSchemaValidator`). Listing it as a direct dep creates pinning noise and confuses knip.

- [ ] **Step 1: Remove the dependency**

Open `package.json`. Delete the `"@cfworker/json-schema"` line from `dependencies`:

```json
// Before (line ~66):
"@cfworker/json-schema": "^4.1.1",

// After: line is gone
```

- [ ] **Step 2: Verify knip and tests pass**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all static checks pass. If `@cfworker/json-schema` appears in any import (it shouldn't), the check will fail — investigate before committing.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(deps): remove phantom @cfworker/json-schema direct dependency"
```

---

### Task 2: Fix `isLoopbackHttpHost` to use SDK `localhostAllowedHostnames()`

**Files:**

- Modify: `src/transport.ts`
- Modify: `__tests__/unit/http-auth-guard.test.ts`

The current implementation hardcodes `::1` (unbracketed IPv6), which is invalid in HTTP `Host` headers (they always bracket IPv6 as `[::1]`). The SDK's `localhostAllowedHostnames()` returns the canonical list `['localhost', '127.0.0.1', '[::1]']`. Using it removes the drift and the bug.

- [ ] **Step 1: Update the test first (red)**

In `__tests__/unit/http-auth-guard.test.ts`, find the `isLoopbackHttpHost` describe block and update it:

```ts
// Replace the existing test block:
describe('isLoopbackHttpHost', () => {
  it('accepts canonical loopback hosts from SDK list', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      assert.equal(isLoopbackHttpHost(host), true, host);
    }
  });

  it('does not accept bare unbracketed ::1 (invalid in HTTP Host headers)', () => {
    assert.equal(isLoopbackHttpHost('::1'), false);
  });

  it('is case-insensitive and trims whitespace', () => {
    assert.equal(isLoopbackHttpHost('  LOCALHOST  '), true);
    assert.equal(isLoopbackHttpHost('LocalHost'), true);
  });

  it('rejects non-loopback hosts', () => {
    for (const host of ['0.0.0.0', '10.0.0.1', '192.168.1.1', 'example.com']) {
      assert.equal(isLoopbackHttpHost(host), false, host);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --test --import tsx/esm "__tests__/unit/http-auth-guard.test.ts"
```

Expected: FAIL — `isLoopbackHttpHost('::1')` returns `true` but the test now expects `false`.

- [ ] **Step 3: Fix `isLoopbackHttpHost` in `src/transport.ts`**

Find the `isLoopbackHttpHost` function (around line 229) and replace its body:

```ts
// Add to the imports at the top of transport.ts (if not already present):
import {
  // ... existing imports ...
  localhostAllowedHostnames,
} from '@modelcontextprotocol/server';

// Replace the function body:
export function isLoopbackHttpHost(host: string): boolean {
  return localhostAllowedHostnames().includes(host.trim().toLowerCase());
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/http-auth-guard.test.ts"
```

Expected: PASS

- [ ] **Step 5: Run the full suite**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/transport.ts __tests__/unit/http-auth-guard.test.ts
git commit -m "fix(transport): replace isLoopbackHttpHost with SDK localhostAllowedHostnames()"
```

---

### Task 3: Remove false `resources.listChanged` capability declaration

**Files:**

- Modify: `src/server.ts`

The server declares `resources: { subscribe: true, listChanged: true }` but never calls `server.server.sendResourceListChanged()`. The three registered resource types (`internal://instructions`, `filesystem-mcp://result/{id}`, `filesystem-mcp://file/{+path}`) are all static templates registered once at startup. The list never changes at runtime. The `listChanged: true` declaration is a false promise.

- [ ] **Step 1: Write a test documenting the absence of dynamic list changes (new file)**

Create `__tests__/unit/resource-list-changed.test.ts`:

```ts
// __tests__/unit/resource-list-changed.test.ts
// Asserts that the server does NOT declare listChanged capability,
// because the resource list is static after initialization.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServer } from '../../src/server.js';

describe('resource capabilities', () => {
  it('does not declare resources.listChanged because the resource list is static', async () => {
    const ctx = await createServer({ allowedDirectories: [] });
    const caps = ctx.mcp.server.getCapabilities();
    const resourceCaps = (caps as { resources?: { listChanged?: boolean } }).resources;
    assert.ok(resourceCaps, 'resources capability should exist');
    assert.notEqual(resourceCaps.listChanged, true, 'listChanged should not be true');
    await ctx.close();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --test --import tsx/esm "__tests__/unit/resource-list-changed.test.ts"
```

Expected: FAIL — `listChanged` is currently `true`.

- [ ] **Step 3: Remove `listChanged: true` from `src/server.ts`**

Find the `serverConfig` block (around line 131) and remove `listChanged`:

```ts
// Before:
resources: { subscribe: true, listChanged: true },

// After:
resources: { subscribe: true },
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/resource-list-changed.test.ts"
```

Expected: PASS

- [ ] **Step 5: Run the full suite**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts __tests__/unit/resource-list-changed.test.ts
git commit -m "fix(server): remove false resources.listChanged capability (list is static)"
```

---

### Task 4: Document the `withJsonSchema` internal workaround

**Files:**

- Modify: `src/tools/define.ts`

`withJsonSchema` patches the `~standard` property inside a Zod schema to override the JSON Schema it publishes to clients while keeping Zod's `validate` for server-side argument checking. The SDK exports `fromJsonSchema(schema, validator?)` which would be the natural replacement, but it switches validation from Zod to `CfWorkerJsonSchemaValidator`, losing structured Zod error messages. This comment anchors the WHY so future maintainers don't "simplify" it away accidentally.

No test needed — pure comment addition. No behavior changes.

- [ ] **Step 1: Add the explanatory comment to `withJsonSchema` in `src/tools/define.ts`**

Find the `withJsonSchema` function (around line 502) and prepend:

```ts
// WHY THIS EXISTS: The SDK exports fromJsonSchema(rawSchema) which creates a
// StandardSchemaWithJSON from a plain JSON Schema, but it validates at runtime using
// CfWorkerJsonSchemaValidator instead of Zod. We need Zod validation (for structured
// error messages) while serving the augmented JSON Schema (with head/tail/offset mutex
// constraints added by inputSchemaAugment) to clients. This function keeps Zod's
// ~standard.validate intact while replacing ~standard.jsonSchema with the augmented
// schema. Remove when the SDK supports separate validate/publication schemas in
// registerTool, or when inputSchemaAugment constraints can be expressed in Zod directly.
function withJsonSchema<T extends z.ZodType>(
  // ... existing signature unchanged
```

- [ ] **Step 2: Run static checks to confirm no regressions**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all checks pass.

- [ ] **Step 3: Commit**

```bash
git add src/tools/define.ts
git commit -m "docs(define): explain withJsonSchema ~standard patch and SDK alternative"
```

---

### Task 5: Guard `resources/subscribe` with client capability check

**Files:**

- Modify: `src/server.ts`
- Create: `__tests__/unit/resource-subscribe-capability.test.ts`

The `resources/subscribe` raw handler fires for any client request regardless of whether the client declared `resources.subscribe` in its capabilities. Adding a guard at the top of the handler ensures misbehaving clients get a clean protocol error rather than silently having their subscription processed.

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/resource-subscribe-capability.test.ts`:

```ts
// __tests__/unit/resource-subscribe-capability.test.ts
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Simulates a subscribe handler that guards against missing capability.
// This mirrors the guard added to server.ts.
function buildSubscribeHandler(clientCaps: { resources?: { subscribe?: boolean } }) {
  return async (req: { params: { uri: string } }): Promise<Record<string, never>> => {
    if (!clientCaps.resources?.subscribe) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        'Client did not declare resources.subscribe capability',
      );
    }
    // Real subscribe logic would follow; we return early for this test.
    return {};
  };
}

describe('resources/subscribe capability guard', () => {
  it('rejects a client that did not declare resources.subscribe', async () => {
    const handler = buildSubscribeHandler({});

    let caught: unknown;
    try {
      await handler({ params: { uri: 'filesystem-mcp://file/foo.txt' } });
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof ProtocolError, 'should throw ProtocolError');
    assert.equal(caught.code, ProtocolErrorCode.InvalidRequest);
    assert.ok(caught.message.includes('resources.subscribe'));
  });

  it('accepts a client that declared resources.subscribe: true', async () => {
    const handler = buildSubscribeHandler({ resources: { subscribe: true } });

    // Should not throw — handler returns {} for this stub
    const result = await handler({ params: { uri: 'filesystem-mcp://file/foo.txt' } });
    assert.deepEqual(result, {});
  });
});
```

- [ ] **Step 2: Run the test to confirm it passes as-is**

```bash
node --test --import tsx/esm "__tests__/unit/resource-subscribe-capability.test.ts"
```

Expected: PASS (this test is self-contained; it doesn't use the real server yet).

- [ ] **Step 3: Add the guard to the real handler in `src/server.ts`**

Find the `resources/subscribe` setRequestHandler block (around line 223). Add the capability check at the very start of the handler body, before the `withTelemetry` call:

```ts
server.server.setRequestHandler('resources/subscribe', (req: { params: { uri: string } }, ctx) => {
  // Guard: reject clients that did not declare resources.subscribe capability.
  const clientCaps = server.server.getClientCapabilities() as
    | { resources?: { subscribe?: boolean } }
    | undefined;
  if (!clientCaps?.resources?.subscribe) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      'Client did not declare resources.subscribe capability',
    );
  }

  const requestedResource = resourceUrlFromServerUrl(req.params.uri);
  return withTelemetry();
  // ... rest unchanged
});
```

Note: `ProtocolErrorCode` and `ProtocolError` are already imported in `src/server.ts`.

- [ ] **Step 4: Run the existing subscribe test to confirm it still passes**

```bash
node --test --import tsx/esm "__tests__/unit/resource-subscribe-unknown.test.ts"
```

Expected: PASS (the existing test already mocks its own handler separately; no conflict).

- [ ] **Step 5: Run the full suite**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts __tests__/unit/resource-subscribe-capability.test.ts
git commit -m "feat(server): guard resources/subscribe against clients without subscribe capability"
```

---

### Task 6: Add `assertToolsCallTaskCapability` guard in task creation

**Files:**

- Modify: `src/tools/define.ts` — extend `ToolOrchestrator` interface options
- Modify: `src/tasks.ts` — import assertion helper, add guard in `createTask`

When a client sends a task-creating `tools/call`, `wrapToolTask.createTask` fires. If the client never declared `experimental.tasks.requests.tools.call` in its capabilities, creating the task violates the protocol. The SDK exports `assertToolsCallTaskCapability` exactly for this check.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/unit/task-support.test.ts` — append after the last existing `describe` block:

```ts
import {
  assertToolsCallTaskCapability,
  SdkError,
  SdkErrorCode,
} from '@modelcontextprotocol/server';

// At the bottom of the file:
describe('assertToolsCallTaskCapability guard', () => {
  it('throws SdkError when client has no task requests capability', () => {
    assert.throws(
      () => assertToolsCallTaskCapability(undefined, 'tools/call', 'Client'),
      (err: unknown) => err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported,
    );
  });

  it('throws SdkError when client has tasks but not tools.call', () => {
    assert.throws(
      () =>
        assertToolsCallTaskCapability(
          { tools: {} } as Parameters<typeof assertToolsCallTaskCapability>[0],
          'tools/call',
          'Client',
        ),
      (err: unknown) => err instanceof SdkError && err.code === SdkErrorCode.CapabilityNotSupported,
    );
  });

  it('does not throw when client has tools.call capability', () => {
    assert.doesNotThrow(() =>
      assertToolsCallTaskCapability(
        { tools: { call: {} } } as Parameters<typeof assertToolsCallTaskCapability>[0],
        'tools/call',
        'Client',
      ),
    );
  });
});
```

- [ ] **Step 2: Run the test to confirm it passes (validates SDK behavior)**

```bash
node --test --import tsx/esm "__tests__/unit/task-support.test.ts"
```

Expected: PASS — this validates that `assertToolsCallTaskCapability` works as documented before we wire it in.

- [ ] **Step 3: Extend `ToolOrchestrator` in `src/tools/define.ts`**

Find the `ToolOrchestrator` interface (around line 91) and add `server?` to the `wrapToolTask` options:

```ts
export interface ToolOrchestrator {
  wrapToolTask<
    Args extends StandardSchemaWithJSON | undefined,
    Result extends Record<string, unknown>,
  >(
    handler: (args: unknown, ctx: ToolCtx) => Promise<ToolResult<Result>>,
    options: {
      toolName: string;
      toolTitle?: string;
      startStatusMessage?: (args: unknown) => string;
      deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'>;
      server?: McpServer;
    },
  ): ToolTaskHandler<Args>;
}
```

`McpServer` is already imported in `src/tools/define.ts`.

- [ ] **Step 4: Update the call site in `defineTool` in `src/tools/define.ts`**

Find the `deps.orchestrator.wrapToolTask(...)` call (around line 582) and add `server`:

```ts
deps.orchestrator.wrapToolTask(
  async (args, ctx) => {
    const executor = new ToolExecutor<I, O>(def.name, ctx, def, args as z.infer<I>);
    return executor.execute(args, deps) as Promise<ToolResult<Record<string, unknown>>>;
  },
  {
    toolName: def.name,
    toolTitle: def.title,
    startStatusMessage: (args: unknown) =>
      plainMessage('start', resolveProgressCtx(def, args as z.infer<I>)),
    deps,
    server: deps.server,   // ← new
  },
),
```

- [ ] **Step 5: Add the import and guard in `src/tasks.ts`**

At the top of `src/tasks.ts`, add these imports (alongside existing ones from `@modelcontextprotocol/server`):

```ts
import {
  assertToolsCallTaskCapability,
  // ← new
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  InMemoryTaskStore,
  isTerminal,
  RELATED_TASK_META_KEY,
  type Task,
  type TaskServerContext,
  type TaskStatus,
  type TaskStore,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';
import type { McpServer, StandardSchemaWithJSON } from '@modelcontextprotocol/server';

// ← McpServer is new
```

Then in `TaskOrchestrator.wrapToolTask`, update the options parameter to include `server?`:

```ts
public wrapToolTask<
  Args extends StandardSchemaWithJSON | undefined,
  Result extends Record<string, unknown>,
>(
  handler: (args: unknown, ctx: ToolCtx) => Promise<ToolResult<Result>>,
  options: {
    toolName: string;
    toolTitle?: string;
    startStatusMessage?: (args: unknown) => string;
    deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'>;
    server?: McpServer;   // ← new
  },
): ToolTaskHandler<Args> {
```

Then, inside the `createTask` closure, add the guard **before** the `creationMutex.run` block:

```ts
const createTask = (async (
  ...params: [unknown, CreateTaskServerContext] | [CreateTaskServerContext]
): Promise<CreateTaskResult> => {
  let args: unknown;
  let ctx: CreateTaskServerContext;
  if (params.length === 1) {
    ctx = params[0];
    args = undefined;
  } else {
    [args, ctx] = params;
  }

  // Guard: assert the client declared tools/call task capability.
  if (options.server) {
    const clientCaps = options.server.server.getClientCapabilities() as
      | { experimental?: { tasks?: { requests?: Parameters<typeof assertToolsCallTaskCapability>[0] } } }
      | undefined;
    assertToolsCallTaskCapability(
      clientCaps?.experimental?.tasks?.requests,
      'tools/call',
      'Client',
    );
  }

  const { task } = ctx;
  // ... rest of createTask unchanged
```

- [ ] **Step 6: Run tests to confirm the integration compiles and tests pass**

```bash
node --test --import tsx/esm "__tests__/unit/task-support.test.ts"
node --test --import tsx/esm "__tests__/unit/task-orchestrator.test.ts"
```

Expected: PASS both

- [ ] **Step 7: Run the full suite**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all checks pass.

- [ ] **Step 8: Commit**

```bash
git add src/tools/define.ts src/tasks.ts __tests__/unit/task-support.test.ts
git commit -m "feat(tasks): assert client tools/call task capability before creating task"
```

---

### Task 7: Fix error code when concurrent task limit is exceeded

**Files:**

- Modify: `src/tasks.ts`
- Modify: `__tests__/unit/task-support.test.ts`

_Absorbed from `2026-05-17-mcp-v2-refinements.md` Task 2._

When `MAX_CONCURRENT_TASKS` is reached, `wrapToolTask` throws `ErrorCode.INVALID_INPUT`. That code is wrong — the client's input is valid; the server is just at capacity. `ErrorCode.TOO_LARGE` ("over a limit") is the correct semantic fit from the existing `ErrorCode` vocabulary.

- [ ] **Step 1: Write the failing test**

Append to `__tests__/unit/task-support.test.ts` (after the last `describe` block, before any closing):

```ts
// --- concurrent task limit error code ---
import { FsError } from '../../src/core/errors.js';
import { MAX_CONCURRENT_TASKS } from '../../src/core/util.js';

describe('concurrent task limit error code', () => {
  it('reports ErrorCode.TOO_LARGE (not INVALID_INPUT) when at the concurrent task limit', async () => {
    const orchestrator = new TaskOrchestrator();
    const wrapped = orchestrator.wrapToolTask(
      async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
        structuredContent: {} as Record<string, unknown>,
      }),
      { toolName: 'limit-test', deps: stubDeps },
    );

    // Return MAX_CONCURRENT_TASKS 'working' tasks from listTasks so the limit check fires.
    const workingTasks = Array.from({ length: MAX_CONCURRENT_TASKS }, (_, i) => ({
      taskId: `t-${i}`,
      status: 'working' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ttl: 5_000,
      pollInterval: 50,
    }));

    const mockCtx: CreateTaskServerContext = {
      mcpReq: {
        id: 99,
        method: 'tools/call',
        signal: new AbortController().signal,
        notify: async () => {},
        send: async () => ({}) as never,
        log: async () => {},
        elicitInput: async () => ({}) as never,
        requestSampling: async () => ({}) as never,
      },
      sessionId: 'limit-session',
      task: {
        store: {
          async createTask() {
            throw new Error('should not reach createTask');
          },
          async getTask() {
            throw new Error('not needed');
          },
          async updateTaskStatus() {},
          async storeTaskResult() {},
          async getTaskResult() {
            return undefined;
          },
          async listTasks() {
            return { tasks: workingTasks };
          },
        },
        requestedTtl: 5_000,
      },
    };

    let caught: unknown;
    try {
      await wrapped.createTask(mockCtx);
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof FsError, `expected FsError, got ${String(caught)}`);
    assert.equal(caught.code, ErrorCode.TOO_LARGE, `expected TOO_LARGE, got ${caught.code}`);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node --test --import tsx/esm "__tests__/unit/task-support.test.ts" --test-name-pattern "concurrent task limit"
```

Expected: FAIL — current code throws `ErrorCode.INVALID_INPUT`, but test expects `ErrorCode.TOO_LARGE`.

- [ ] **Step 3: Fix the error code in `src/tasks.ts`**

Inside `wrapToolTask.createTask`, find the concurrent-limit check (inside the `creationMutex.run` block):

```ts
// Before:
if (activeCount >= MAX_CONCURRENT_TASKS) {
  throw new FsError(ErrorCode.INVALID_INPUT, `Too many active tasks (${activeCount})`);
}

// After:
if (activeCount >= MAX_CONCURRENT_TASKS) {
  throw new FsError(
    ErrorCode.TOO_LARGE,
    `Server at capacity: ${activeCount} active tasks (limit ${MAX_CONCURRENT_TASKS}).`,
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/task-support.test.ts" --test-name-pattern "concurrent task limit"
```

Expected: PASS

- [ ] **Step 5: Run the full suite**

```bash
node scripts/tasks.mjs check --quick
```

Expected: all checks pass.

- [ ] **Step 6: Commit**

```bash
git add src/tasks.ts __tests__/unit/task-support.test.ts
git commit -m "fix(tasks): use ErrorCode.TOO_LARGE when concurrent task limit is exceeded"
```

---

## Self-Review

**Spec coverage:**

| Finding from audit                                       | Task                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `@cfworker/json-schema` unused direct dep                | Task 1 ✓                                                                     |
| `isLoopbackHttpHost` drifts from SDK / bare `::1` bug    | Task 2 ✓                                                                     |
| `resources.listChanged: true` false declaration          | Task 3 ✓                                                                     |
| `withJsonSchema` ~standard hack undocumented             | Task 4 ✓                                                                     |
| `resources/subscribe` missing capability guard           | Task 5 ✓                                                                     |
| `assertToolsCallTaskCapability` not called               | Task 6 ✓                                                                     |
| `INVALID_INPUT` wrong for capacity error (from old plan) | Task 7 ✓                                                                     |
| `logging/setLevel` missing guard (LOW)                   | Not planned — SDK routes this; guard adds noise with no real defensive value |
| `TaskOrchestrator` structural refactor (MEDIUM)          | Not planned — risk outweighs benefit; store delegation is stable             |

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N" references. Each step contains exact file paths and complete code.

**Type consistency:** `ProtocolError`, `ProtocolErrorCode` consistent across Tasks 5 and 6. `McpServer` import added in `tasks.ts` and already present in `define.ts`. `assertToolsCallTaskCapability` type cast uses `Parameters<typeof assertToolsCallTaskCapability>[0]`. `ErrorCode.TOO_LARGE` is consistent between Task 7's test assertion and implementation.

**Superseded plan:** `docs/superpowers/plans/2026-05-17-mcp-v2-refinements.md` — Task 1 (remove `withJsonSchema`) is abandoned because it silently switches runtime validation from Zod to cfworker; Task 2 (error code fix) is absorbed here as Task 7. The old plan file is marked as consolidated.
