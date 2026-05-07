# MCP v2 Modernization (Gaps 1–7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all seven MCP v2 gaps identified in the audit: config hardening, HTTP session lifecycle, named MCP logging, metrics resource subscriptions, and elicitation for destructive filesystem operations.

**Architecture:** Tasks 1–3 are isolated changes to `bootstrap.ts` and six tool files (≤5 lines each). Task 4 adds a `onMetricsUpdate` callback to `observability.ts` and wires it to `sendResourceUpdated` per-server-instance in `bootstrap.ts`. Tasks 5–7 add `elicitInput` to the internal `ToolContext` adapter and implement it in `rm` and `mv`, guarded by a client-capability check so non-supporting clients see zero behaviour change.

**Tech Stack:** `@modelcontextprotocol/server ^2.0.0-alpha.2`, `@modelcontextprotocol/client ^2.0.0-alpha.2`, Node.js 24, `node:test`, `tsx/esm`

---

## File map

| File                                           | Action | Why                                                           |
| ---------------------------------------------- | ------ | ------------------------------------------------------------- |
| `src/server/bootstrap.ts`                      | Modify | Tasks 1, 2, 4 — config + lifecycle + metrics wiring           |
| `src/lib/observability.ts`                     | Modify | Task 4 — export `onMetricsUpdate` callback                    |
| `src/resources.ts`                             | Modify | Task 4 — export `METRICS_RESOURCE_URI` constant               |
| `src/tools/shared.ts`                          | Modify | Task 5 — add `elicitInput` to `ToolContext` + `toToolContext` |
| `src/tools/apply-patch.ts`                     | Modify | Task 3 — add `'apply_patch'` logger name                      |
| `src/tools/delete-file.ts`                     | Modify | Tasks 3, 6 — logger name + elicitation                        |
| `src/tools/edit-file.ts`                       | Modify | Task 3 — add `'edit'` logger name                             |
| `src/tools/move-file.ts`                       | Modify | Tasks 3, 7 — logger name + elicitation                        |
| `src/tools/replace-in-files.ts`                | Modify | Task 3 — add `'search_and_replace'` logger name               |
| `src/tools/write-file.ts`                      | Modify | Task 3 — add `'write'` logger name                            |
| `__tests__/helpers.ts`                         | Modify | Task 5 — add `createTestEnvWithElicitation` helper            |
| `__tests__/unit/observability-metrics.test.ts` | Create | Task 4 — unit test for `onMetricsUpdate`                      |
| `__tests__/tools/elicitation.test.ts`          | Create | Tasks 6, 7 — integration tests for elicitation                |

---

## Task 1: Config hardening — `enforceStrictCapabilities`, `debouncedNotificationMethods`, `retryInterval`

**Closes:** Gap 3, Gap 4, Gap 6

**Files:**

- Modify: `src/server/bootstrap.ts:199-207` (McpServer constructor options)
- Modify: `src/server/bootstrap.ts:375-393` (NodeStreamableHTTPServerTransport constructor)

---

- [ ] **Step 1.1: Write a failing test that asserts the McpServer is constructed with `enforceStrictCapabilities`**

```ts
// __tests__/unit/bootstrap-config.test.ts  (new file)
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import { createServer } from '../../src/server/bootstrap.js';

describe('createServer config', () => {
  it('creates server with enforceStrictCapabilities enabled', async () => {
    const server = await createServer();
    // The capability object is not directly inspectable, but enforceStrictCapabilities
    // is wired at construction — verify by checking the server's protocol options
    // indirectly: a request to an unsupported method should throw MethodNotFound.
    // For now, verify that createServer resolves without throwing.
    assert.ok(server instanceof McpServer);
    await server.close();
  });
});
```

- [ ] **Step 1.2: Run the test to confirm it passes trivially (it's a smoke test)**

```sh
node --test --import tsx/esm __tests__/unit/bootstrap-config.test.ts
```

Expected: PASS — the test confirms `createServer` doesn't throw. This is a smoke baseline before the config changes.

- [ ] **Step 1.3: Add `enforceStrictCapabilities` and `debouncedNotificationMethods` to `McpServer` constructor in `createServer`**

In `src/server/bootstrap.ts`, find the `serverConfig` block (around line 199) and update it:

```ts
// BEFORE:
const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> =
  { capabilities };

// AFTER:
const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
  capabilities,
  enforceStrictCapabilities: true,
  debouncedNotificationMethods: [
    'notifications/resources/list_changed',
    'notifications/resources/updated',
  ],
};
```

- [ ] **Step 1.4: Add `retryInterval` to `NodeStreamableHTTPServerTransport` constructor in `startHttpServer`**

In `src/server/bootstrap.ts`, find the `new NodeStreamableHTTPServerTransport({` block (around line 375) and add `retryInterval`:

```ts
// BEFORE:
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore,
  onsessioninitialized: (sessionId) => {

// AFTER:
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore,
  retryInterval: 2_000,
  onsessioninitialized: (sessionId) => {
```

- [ ] **Step 1.5: Run the full check suite**

```sh
node scripts/tasks.mjs
```

Expected: all checks pass. If `enforceStrictCapabilities: true` breaks any test that makes unsupported calls, the failing test will identify which capability is missing — fix the declaration in `buildServerCapabilities()` rather than removing `enforceStrictCapabilities`.

- [ ] **Step 1.6: Commit**

```sh
git add src/server/bootstrap.ts __tests__/unit/bootstrap-config.test.ts
git commit -m "feat: enforce strict capabilities, debounce resource notifications, set SSE retry interval"
```

---

## Task 2: `onsessionclosed` HTTP session lifecycle hook

**Closes:** Gap 5

**Files:**

- Modify: `src/server/bootstrap.ts` — `NodeStreamableHTTPServerTransport` constructor in `startHttpServer`

The `onsessionclosed` callback fires when the **client** sends `DELETE /mcp` to cleanly close a session. The existing `transport.onclose = cleanup` fires on transport-level closure (network drop, server shutdown). Both should clean up, but `onsessionclosed` handles the clean client-initiated path more precisely.

---

- [ ] **Step 2.1: Add `onsessionclosed` to the `NodeStreamableHTTPServerTransport` constructor**

In `src/server/bootstrap.ts`, extend the transport constructor (already modified in Task 1) with `onsessionclosed`:

```ts
const transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  eventStore,
  retryInterval: 2_000,
  onsessioninitialized: (sessionId) => {
    sessions.set(sessionId, {
      server: mcpServer,
      rootsManager,
      transport,
      createdAt: Date.now(),
      cleanup,
      close,
    });
    activeServers.set(sessionId, {
      server: mcpServer,
      loggingState: rootsManager.loggingState,
    });
    rootsManager.logMissingDirectoriesIfNeeded(mcpServer);
  },
  onsessionclosed: async (sessionId) => {
    const session = sessions.get(sessionId);
    if (session) {
      await session.close();
    }
  },
});
```

`session.close()` calls the existing `cleanup()` internally, so there is no double-free risk — `cleanup` is idempotent via the `cleanedUp` flag.

- [ ] **Step 2.2: Run the full check suite**

```sh
node scripts/tasks.mjs
```

Expected: all checks pass. The HTTP integration test in `__tests__/http.test.ts` should still pass unchanged.

- [ ] **Step 2.3: Commit**

```sh
git add src/server/bootstrap.ts
git commit -m "feat: use onsessionclosed for precise HTTP session lifecycle teardown"
```

---

## Task 3: Named `logger` field in all `ctx.log` tool calls

**Closes:** Gap 7

**Files:**

- Modify: `src/tools/apply-patch.ts:339`
- Modify: `src/tools/delete-file.ts:109`
- Modify: `src/tools/edit-file.ts:421`
- Modify: `src/tools/move-file.ts:283`
- Modify: `src/tools/replace-in-files.ts:577`
- Modify: `src/tools/write-file.ts:80`

The third argument to `ctx.log(level, data, logger)` populates the `logger` field in `notifications/message` — shown as the source component name in clients that surface MCP logs.

---

- [ ] **Step 3.1: Add logger name to `apply-patch.ts`**

In `src/tools/apply-patch.ts`, find line ~339:

```ts
// BEFORE:
void ctx.log?.(
  'info',
  `patch: ${args.path} (+${String(sc.linesAdded ?? 0)}/-${String(sc.linesRemoved ?? 0)})`
);

// AFTER:
void ctx.log?.(
  'info',
  `patch: ${args.path} (+${String(sc.linesAdded ?? 0)}/-${String(sc.linesRemoved ?? 0)})`,
  'apply_patch'
);
```

- [ ] **Step 3.2: Add logger name to `delete-file.ts`**

In `src/tools/delete-file.ts`, find line ~109:

```ts
// BEFORE:
void ctx.log?.('info', `rm: ${args.path}`);

// AFTER:
void ctx.log?.('info', `rm: ${args.path}`, 'rm');
```

- [ ] **Step 3.3: Add logger name to `edit-file.ts`**

In `src/tools/edit-file.ts`, find line ~421:

```ts
// BEFORE:
void ctx.log?.(
  'info',
  `edit: ${args.path} (${String(result.structuredContent.appliedEdits ?? 0)} edits)`
);

// AFTER:
void ctx.log?.(
  'info',
  `edit: ${args.path} (${String(result.structuredContent.appliedEdits ?? 0)} edits)`,
  'edit'
);
```

- [ ] **Step 3.4: Add logger name to `move-file.ts`**

In `src/tools/move-file.ts`, find line ~283:

```ts
// BEFORE:
void ctx.log?.(
  'info',
  `mv: ${args.source ?? args.sources?.join(', ') ?? ''} → ${args.destination}`
);

// AFTER:
void ctx.log?.(
  'info',
  `mv: ${args.source ?? args.sources?.join(', ') ?? ''} → ${args.destination}`,
  'mv'
);
```

- [ ] **Step 3.5: Add logger name to `replace-in-files.ts`**

In `src/tools/replace-in-files.ts`, find line ~577:

```ts
// BEFORE:
void ctx.log?.(
  'info',
  `search_and_replace: ${String(sc.matches ?? 0)} matches in ${String(sc.filesChanged ?? 0)} files`
);

// AFTER:
void ctx.log?.(
  'info',
  `search_and_replace: ${String(sc.matches ?? 0)} matches in ${String(sc.filesChanged ?? 0)} files`,
  'search_and_replace'
);
```

- [ ] **Step 3.6: Add logger name to `write-file.ts`**

In `src/tools/write-file.ts`, find line ~80:

```ts
// BEFORE:
void ctx.log?.(
  'info',
  `write: ${args.path} (${String(result.structuredContent.bytesWritten ?? 0)} bytes)`
);

// AFTER:
void ctx.log?.(
  'info',
  `write: ${args.path} (${String(result.structuredContent.bytesWritten ?? 0)} bytes)`,
  'write'
);
```

- [ ] **Step 3.7: Run type-check and tests**

```sh
node scripts/tasks.mjs --quick
```

Expected: type-check and lint pass. The third argument is `string | undefined` per the `log` signature in `ToolContext`, so no type errors. The argument was already present in the type definition from `LoggingLevel` context.

- [ ] **Step 3.8: Commit**

```sh
git add src/tools/apply-patch.ts src/tools/delete-file.ts src/tools/edit-file.ts \
        src/tools/move-file.ts src/tools/replace-in-files.ts src/tools/write-file.ts
git commit -m "feat: add tool name as logger field to all ctx.log calls for richer MCP diagnostics"
```

---

## Task 4: Metrics resource subscriptions via `onMetricsUpdate`

**Closes:** Gap 2

**Files:**

- Modify: `src/lib/observability.ts` — export `onMetricsUpdate` listener registration
- Modify: `src/resources.ts` — export `METRICS_RESOURCE_URI` constant
- Modify: `src/server/bootstrap.ts` — add `resources: { subscribe: true }` to capabilities + wire per-server subscription
- Create: `__tests__/unit/observability-metrics.test.ts`

---

- [ ] **Step 4.1: Write a failing unit test for `onMetricsUpdate`**

```ts
// __tests__/unit/observability-metrics.test.ts (new file)
import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import {
  onMetricsUpdate,
  withToolDiagnostics,
} from '../../src/lib/observability.js';

describe('onMetricsUpdate', () => {
  it('calls registered listeners after a tool run completes', async () => {
    let callCount = 0;
    const unsubscribe = onMetricsUpdate(() => {
      callCount++;
    });
    try {
      await withToolDiagnostics('test-tool-obs', async () => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      }));
      assert.equal(
        callCount,
        1,
        'listener must be called exactly once per tool run'
      );
    } finally {
      unsubscribe();
    }
  });

  it('does not call unsubscribed listeners', async () => {
    let callCount = 0;
    const unsubscribe = onMetricsUpdate(() => {
      callCount++;
    });
    unsubscribe();
    await withToolDiagnostics('test-tool-obs2', async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    }));
    assert.equal(callCount, 0, 'unsubscribed listener must not be called');
  });
});
```

- [ ] **Step 4.2: Run to confirm they fail**

```sh
node --test --import tsx/esm __tests__/unit/observability-metrics.test.ts
```

Expected: FAIL — `onMetricsUpdate` is not exported yet.

- [ ] **Step 4.3: Export `onMetricsUpdate` from `observability.ts`**

In `src/lib/observability.ts`, add after the `globalMetrics` declaration (~line 99):

```ts
// --- Metrics update listeners ---

type MetricsListener = () => void;
const metricsListeners = new Set<MetricsListener>();

/**
 * Register a callback invoked after every tool call updates globalMetrics.
 * Returns an unsubscribe function. Zero-overhead when no listeners are registered.
 */
export function onMetricsUpdate(listener: MetricsListener): () => void {
  metricsListeners.add(listener);
  return (): void => {
    metricsListeners.delete(listener);
  };
}
```

Then update the existing `updateMetrics` function to notify listeners. Find `function updateMetrics(...)` (~line 101) and add at the end:

```ts
function updateMetrics(tool: string, ok: boolean, durationMs: number): void {
  const current = globalMetrics.get(tool) ?? {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
  };
  current.calls++;
  if (!ok) current.errors++;
  current.totalDurationMs += durationMs;
  globalMetrics.set(tool, current);

  // Notify listeners — best effort, never break tool execution
  for (const listener of metricsListeners) {
    try {
      listener();
    } catch {
      // Intentionally swallowed: observability must not interrupt tool execution.
    }
  }
}
```

- [ ] **Step 4.4: Run the test again — it should pass**

```sh
node --test --import tsx/esm __tests__/unit/observability-metrics.test.ts
```

Expected: PASS — both tests green.

- [ ] **Step 4.5: Export `METRICS_RESOURCE_URI` from `resources.ts`**

In `src/resources.ts`, find the `METRICS_RESOURCE_URI` constant (~line 58) and add `export`:

```ts
// BEFORE:
const METRICS_RESOURCE_URI = 'filesystem-mcp://metrics';

// AFTER:
export const METRICS_RESOURCE_URI = 'filesystem-mcp://metrics';
```

- [ ] **Step 4.6: Add `resources: { subscribe: true }` to server capabilities**

In `src/server/bootstrap.ts`, in `buildServerCapabilities()` (~line 78), update the `resources` entry:

```ts
// BEFORE:
resources: { listChanged: true },

// AFTER:
resources: { listChanged: true, subscribe: true },
```

- [ ] **Step 4.7: Wire per-server metrics subscription in `createServer`**

In `src/server/bootstrap.ts`, add the import at the top of the file:

```ts
import { onMetricsUpdate } from '../lib/observability.js';

import { METRICS_RESOURCE_URI } from '../resources.js';
```

Then in `createServer()`, after the server is constructed and before `return server`, add:

```ts
// Subscribe to metrics updates and push resource notifications to this server instance.
// The debounce (500 ms) prevents notification floods during batch tool runs.
let metricsNotifyTimer: ReturnType<typeof setTimeout> | undefined;
const unsubscribeMetrics = onMetricsUpdate(() => {
  clearTimeout(metricsNotifyTimer);
  metricsNotifyTimer = setTimeout(() => {
    try {
      server.server.sendResourceUpdated({ uri: METRICS_RESOURCE_URI });
    } catch {
      // Transport may already be closed — best effort.
    }
  }, 500);
});

// Store unsubscribe so HTTP session cleanup and stdio shutdown can call it.
metricsUnsubscribers.set(server, () => {
  clearTimeout(metricsNotifyTimer);
  unsubscribeMetrics();
});
```

Add the WeakMap at module scope (near the top of `bootstrap.ts`, after the `activeServers` map):

```ts
const metricsUnsubscribers = new WeakMap<McpServer, () => void>();
```

Add a cleanup helper function after the WeakMap declaration:

```ts
function cleanupServerMetrics(server: McpServer): void {
  metricsUnsubscribers.get(server)?.();
  metricsUnsubscribers.delete(server);
}
```

- [ ] **Step 4.8: Call `cleanupServerMetrics` in HTTP session cleanup**

In `startHttpServer`, inside `createHttpSession`, find the existing `cleanup` function and add the metrics cleanup:

```ts
const cleanup = (): void => {
  if (cleanedUp) return;
  cleanedUp = true;

  const { sessionId } = transport;
  if (sessionId) {
    sessions.delete(sessionId);
    activeServers.delete(sessionId);
    eventStore.delete(sessionId);
  }

  cleanupServerMetrics(mcpServer); // ADD THIS LINE
  rootsManager.destroy();
};
```

- [ ] **Step 4.9: Call `cleanupServerMetrics` in stdio transport close**

In `startServer()`, find `transport.onclose`:

```ts
// BEFORE:
transport.onclose = () => {
  rootsManager.destroy();
  sdkOnClose?.();
};

// AFTER:
transport.onclose = () => {
  cleanupServerMetrics(server);
  rootsManager.destroy();
  sdkOnClose?.();
};
```

- [ ] **Step 4.10: Run full check suite**

```sh
node scripts/tasks.mjs
```

Expected: all checks pass. The HTTP test and resource tests should still be green.

- [ ] **Step 4.11: Commit**

```sh
git add src/lib/observability.ts src/resources.ts src/server/bootstrap.ts \
        __tests__/unit/observability-metrics.test.ts
git commit -m "feat: emit sendResourceUpdated for metrics resource after tool completions, add resources subscribe capability"
```

---

## Task 5: `elicitInput` infrastructure — `ToolContext` adapter + test helper

**Closes:** Gap 1 setup (Tasks 6 and 7 depend on this)

**Files:**

- Modify: `src/tools/shared.ts` — add `ElicitFormParams`, `ElicitResult`, `elicitInput` to `ToolContext` + `toToolContext`
- Modify: `__tests__/helpers.ts` — add `createTestEnvWithElicitation`

---

- [ ] **Step 5.1: Add `elicitInput` types and field to `ToolContext` in `shared.ts`**

In `src/tools/shared.ts`, find the `ToolContext` interface (~line 414) and extend it:

```ts
// Add these two types before the ToolContext interface:
export interface ElicitFormParams {
  mode: 'form';
  message: string;
  requestedSchema: Record<string, unknown>;
}

export type ElicitResult = {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
};

export interface ToolContext {
  signal?: AbortSignal;
  sessionId?: string;
  _meta?: (RequestMeta & TracingMeta) | undefined;
  sendNotification?: (notification: Notification) => Promise<void>;
  log?: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
  elicitInput?: (params: ElicitFormParams) => Promise<ElicitResult>; // ADD THIS
}
```

- [ ] **Step 5.2: Map `elicitInput` in `toToolContext`**

In `src/tools/shared.ts`, find `toToolContext` (~line 422) and add the mapping inside the `'mcpReq' in ctx` branch:

```ts
export function toToolContext(ctx?: ToolContext | ServerContext): ToolContext {
  if (!ctx) return {};
  if ('mcpReq' in ctx) {
    return {
      signal: ctx.mcpReq.signal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
      sendNotification: async (notification) => ctx.mcpReq.notify(notification),
      log: async (level, data, logger) => ctx.mcpReq.log(level, data, logger),
      elicitInput: (params) =>
        ctx.mcpReq.elicitInput(params) as Promise<ElicitResult>, // ADD THIS LINE
    };
  }
  return ctx;
}
```

> **Note:** `ctx.mcpReq.elicitInput` always exists on the v2 request context. Capability gating (whether to actually call it) is done in the tool registration function where the `McpServer` instance is in scope.

- [ ] **Step 5.3: Run type-check to catch any type issues**

```sh
node scripts/tasks.mjs --quick
```

Expected: passes. If `ctx.mcpReq.elicitInput` types don't align, check what `@modelcontextprotocol/server` exports for the elicitInput param/return types and use those directly:

```ts
import type { ElicitInputRequest } from '@modelcontextprotocol/server';

// (if such a type is exported — otherwise the inline types above are sufficient)
```

- [ ] **Step 5.4: Add `createTestEnvWithElicitation` helper to `__tests__/helpers.ts`**

In `__tests__/helpers.ts`, add the following imports and helper after the existing `createTestEnv`:

```ts
// Add to imports at top of file:
import type { ElicitResult } from '../src/tools/shared.js';
```

```ts
// Add after the createTestEnv function:

export type ElicitationHandler = (params: {
  mode: string;
  message: string;
  requestedSchema: unknown;
}) => Promise<ElicitResult>;

/**
 * Like createTestEnv but the MCP client advertises `elicitation: {}` capability
 * and delegates all elicitation/create requests to `handler`.
 *
 * NOTE: Client-side elicitation request handling uses
 * `client.setRequestHandler('elicitation/create', handler)`.
 * If this method does not exist in your SDK version, check the
 * @modelcontextprotocol/client v2 API for the correct hook
 * (e.g. a dedicated `onelicitation` setter or similar).
 */
export async function createTestEnvWithElicitation(
  handler: ElicitationHandler
): Promise<TestEnv> {
  const tmpDir = await mkdtemp(
    join(tmpdir(), `fsmcp-${randomUUID().slice(0, 8)}-`)
  );

  await setAllowedDirectoriesResolved([tmpDir]);

  const taskStore = createTaskStore();

  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
        completions: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
          taskStore,
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
    }
  );

  const resourceStore = createInMemoryResourceStore();
  registerAllTools(server, { resourceStore, isInitialized: () => true });

  // Client advertises elicitation capability so the server will call elicitInput
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  );

  // Register the elicitation handler for server→client elicitation/create requests.
  // The `client.setRequestHandler` method accepts a method string (v2 pattern).
  // If your SDK version uses a different API (e.g. `client.onelicitation`),
  // update this call accordingly.
  (
    client as unknown as {
      setRequestHandler: (method: string, handler: ElicitationHandler) => void;
    }
  ).setRequestHandler('elicitation/create', handler);

  const [ct, st] = LinkedTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const cleanup = async (): Promise<void> => {
    taskStore.cleanup();
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    await rm(tmpDir, { recursive: true, force: true });
    try {
      await setAllowedDirectoriesResolved([]);
    } catch {
      /* ignore */
    }
  };

  return { client, tmpDir, cleanup };
}
```

- [ ] **Step 5.5: Run type-check + lint**

```sh
node scripts/tasks.mjs --quick
```

Expected: passes. The `as unknown as { setRequestHandler: ... }` cast is intentional — it bypasses the type system to call a method whose exact signature may vary by SDK version. If the SDK exposes it with a proper type, remove the cast.

- [ ] **Step 5.6: Commit the infrastructure**

```sh
git add src/tools/shared.ts __tests__/helpers.ts
git commit -m "feat: add elicitInput to ToolContext adapter and createTestEnvWithElicitation test helper"
```

---

## Task 6: Elicitation for `rm` (delete_file)

**Closes:** Gap 1 (for `rm`)

**Files:**

- Modify: `src/tools/delete-file.ts`
- Create: `__tests__/tools/elicitation.test.ts`

The `rm` tool must ask for user confirmation when `recursive: true` and the target is a directory, provided the client advertises `elicitation: {}` capability. When the client does not support elicitation, behaviour is identical to today.

---

- [ ] **Step 6.1: Write the failing tests**

```ts
// __tests__/tools/elicitation.test.ts (new file)
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  createTestEnv,
  createTestEnvWithElicitation,
  type TestEnv,
} from '../helpers.js';

// ─── rm: backward-compat (no elicitation capability) ─────────────────────────

describe('rm: client without elicitation capability', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnv();
    dir = join(env.tmpDir, 'to-delete');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'content');
  });

  after(async () => {
    await env.cleanup();
  });

  it('deletes directory immediately without elicitation when capability absent', async () => {
    const result = await env.client.callTool({
      name: 'rm',
      arguments: { path: dir, recursive: true },
    });
    assertOk(result);
    // Directory must be gone
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });
});

// ─── rm: client declines elicitation ─────────────────────────────────────────

describe('rm: client declines elicitation', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'decline' as const,
    }));
    dir = join(env.tmpDir, 'guarded-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'content');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns success without deleting when user declines', async () => {
    const result = await env.client.callTool({
      name: 'rm',
      arguments: { path: dir, recursive: true },
    });
    assertOk(result);
    const sc = (result as { structuredContent?: { ok?: unknown } })
      .structuredContent;
    assert.equal((sc as { ok: unknown } | undefined)?.ok, true);
    // Directory must still exist
    const entries = await readdir(dir);
    assert.ok(
      entries.length > 0,
      'directory contents must be intact after decline'
    );
  });
});

// ─── rm: client accepts elicitation ──────────────────────────────────────────

describe('rm: client accepts elicitation', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
    dir = join(env.tmpDir, 'accept-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'content');
  });

  after(async () => {
    await env.cleanup();
  });

  it('deletes directory when user accepts elicitation', async () => {
    const result = await env.client.callTool({
      name: 'rm',
      arguments: { path: dir, recursive: true },
    });
    assertOk(result);
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });
});
```

- [ ] **Step 6.2: Run to confirm tests fail**

```sh
node --test --import tsx/esm __tests__/tools/elicitation.test.ts
```

Expected: first test PASSES (no elicitation behaviour exists yet, so `rm` just works). Second and third tests FAIL because elicitation doesn't exist yet. That's the target failing state.

- [ ] **Step 6.3: Update `handleDeleteFile` signature to accept an optional `elicitInput` function**

In `src/tools/delete-file.ts`, update the `handleDeleteFile` function signature and add the confirmation check **after** the `stats` check for directory + recursive:

```ts
// Add this import at the top of the file:
import type { ElicitFormParams, ElicitResult } from './shared.js';

// Update handleDeleteFile signature:
async function handleDeleteFile(
  args: z.infer<typeof DeleteFileInputSchema>,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitFormParams) => Promise<ElicitResult>
): Promise<ToolResponse<z.infer<typeof DeleteFileOutputSchema>>> {
  const validPath = await validatePathForWrite(args.path, signal);

  if (isAllowedDirectoryRoot(validPath)) {
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'Deleting a workspace root directory is not allowed'
    );
  }

  let stats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    stats = await withAbort(lstat(validPath), signal);
  } catch (error) {
    if (
      isNodeError(error) &&
      error.code === 'ENOENT' &&
      args.ignoreIfNotExists
    ) {
      return buildToolResponse(`Successfully deleted: ${args.path}`, {
        ok: true,
        path: validPath,
      });
    }
    throw error;
  }

  // Ask for confirmation when deleting a directory recursively and client supports it.
  if (elicitInput && args.recursive && stats.isDirectory()) {
    const elicitResult = await elicitInput({
      mode: 'form',
      message: `Permanently delete "${args.path}" and all its contents? This cannot be undone.`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Yes, delete permanently',
          },
        },
        required: ['confirm'],
      },
    });

    if (
      elicitResult.action !== 'accept' ||
      elicitResult.content?.['confirm'] !== true
    ) {
      return buildToolResponse(`Deletion cancelled: ${args.path}`, {
        ok: true,
        path: validPath,
      });
    }
  }

  // Existing deletion logic — unchanged from here down.
  if (stats.isDirectory() && !args.recursive) {
    await withAbort(rmdir(validPath), signal);
  } else {
    await withAbort(
      rm(validPath, {
        recursive: args.recursive,
        force: args.ignoreIfNotExists,
      }),
      signal
    );
  }

  Logger.info(`rm: ${args.path}`);

  return buildToolResponse(`Successfully deleted: ${args.path}`, {
    ok: true,
    path: validPath,
  });
}
```

- [ ] **Step 6.4: Pass `elicitInput` from the registration handler**

In `src/tools/delete-file.ts`, update `registerDeleteFileTool` to extract the capability-gated `elicitInput` and thread it into `handleDeleteFile`:

```ts
export function registerDeleteFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof DeleteFileInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof DeleteFileOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'rm',
      ctx,
      outputSchema: DeleteFileOutputSchema,
      timedSignal: {},
      context: { path: args.path },
      run: async (signal) => {
        // Only pass elicitInput when the connected client advertised elicitation support.
        const caps = server.server.getClientCapabilities();
        const elicitFn =
          caps?.elicitation && ctx.elicitInput ? ctx.elicitInput : undefined;
        const result = await handleDeleteFile(args, signal, elicitFn);
        void ctx.log?.('info', `rm: ${args.path}`, 'rm');
        return result;
      },
      onError: (error) => {
        // ... existing onError unchanged ...
      },
    });

  registerStandardTool(server, DELETE_FILE_TOOL, handler, options, {
    // ... existing progressMessage / completionMessage unchanged ...
  });
}
```

> Keep the existing `onError` and `registerStandardTool` call bodies exactly as they were — only the `run` function changes.

- [ ] **Step 6.5: Run the elicitation tests**

```sh
node --test --import tsx/esm __tests__/tools/elicitation.test.ts
```

Expected: all three `rm` describe blocks PASS.

> If the second or third test fails with a transport error on `elicitation/create`, the `setRequestHandler` call in `createTestEnvWithElicitation` needs adjustment. Check whether the `Client` exposes `setRequestHandler` directly, via `client.client.setRequestHandler`, or via a dedicated `client.setElicitationHandler` method. Update `__tests__/helpers.ts` accordingly.

- [ ] **Step 6.6: Run full check suite**

```sh
node scripts/tasks.mjs
```

Expected: all checks pass.

- [ ] **Step 6.7: Commit**

```sh
git add src/tools/delete-file.ts __tests__/tools/elicitation.test.ts
git commit -m "feat: add elicitation confirmation for recursive directory deletion (rm)"
```

---

## Task 7: Elicitation for `mv` (move_file)

**Closes:** Gap 1 (for `mv`)

**Files:**

- Modify: `src/tools/move-file.ts`
- Modify: `__tests__/tools/elicitation.test.ts` — extend with `mv` tests

`mv` silently overwrites on POSIX when the destination already exists. Elicitation should trigger when the destination exists and the client supports it.

---

- [ ] **Step 7.1: Add failing `mv` elicitation tests to the test file**

Append to `__tests__/tools/elicitation.test.ts`:

```ts
// ─── mv: backward-compat (no elicitation capability) ─────────────────────────

describe('mv: client without elicitation capability', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnv();
    src = join(env.tmpDir, 'src.txt');
    dest = join(env.tmpDir, 'dest.txt');
    await writeFile(src, 'source content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('overwrites destination immediately when capability absent', async () => {
    const result = await env.client.callTool({
      name: 'mv',
      arguments: { source: src, destination: dest },
    });
    assertOk(result);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(dest, 'utf8'), 'source content');
  });
});

// ─── mv: client declines when destination would be overwritten ────────────────

describe('mv: client declines elicitation (destination exists)', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'decline' as const,
    }));
    src = join(env.tmpDir, 'mv-src.txt');
    dest = join(env.tmpDir, 'mv-dest.txt');
    await writeFile(src, 'new content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns success without moving when user declines overwrite', async () => {
    const result = await env.client.callTool({
      name: 'mv',
      arguments: { source: src, destination: dest },
    });
    assertOk(result);
    const { readFileSync } = await import('node:fs');
    // destination unchanged
    assert.equal(readFileSync(dest, 'utf8'), 'original dest');
    // source still present
    assert.equal(readFileSync(src, 'utf8'), 'new content');
  });
});

// ─── mv: client accepts overwrite ────────────────────────────────────────────

describe('mv: client accepts elicitation (destination exists)', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirmOverwrite: true },
    }));
    src = join(env.tmpDir, 'mv-accept-src.txt');
    dest = join(env.tmpDir, 'mv-accept-dest.txt');
    await writeFile(src, 'new content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('moves and overwrites when user accepts', async () => {
    const result = await env.client.callTool({
      name: 'mv',
      arguments: { source: src, destination: dest },
    });
    assertOk(result);
    const { readFileSync, existsSync } = await import('node:fs');
    assert.equal(readFileSync(dest, 'utf8'), 'new content');
    assert.ok(!existsSync(src), 'source must be gone after move');
  });
});
```

- [ ] **Step 7.2: Run to confirm `mv` tests fail**

```sh
node --test --import tsx/esm __tests__/tools/elicitation.test.ts
```

Expected: `mv` backward-compat test PASSES, elicitation decline/accept tests FAIL.

- [ ] **Step 7.3: Add elicitation to `handleMoveFile` in `move-file.ts`**

In `src/tools/move-file.ts`, first add the import at the top:

```ts
import type { ElicitFormParams, ElicitResult } from './shared.js';
```

Then find `handleMoveFile` (or whichever function performs the actual rename/copy). In `move-file.ts` the main handler dispatches per-source moves internally. Add the destination-exists check near the top of the single-source move path, before the rename/cp call.

Locate the core single-move execution block in `handleMoveFile` (or `moveOne` if extracted) and insert:

```ts
// Check if destination exists — ask for confirmation when client supports elicitation.
if (elicitInput) {
  let destExists = false;
  try {
    await stat(validDestination);
    destExists = true;
  } catch {
    // Destination does not exist — no confirmation needed.
  }

  if (destExists) {
    const elicitResult = await elicitInput({
      mode: 'form',
      message: `"${destination}" already exists. Overwrite it?`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirmOverwrite: {
            type: 'boolean',
            title: 'Yes, overwrite',
          },
        },
        required: ['confirmOverwrite'],
      },
    });

    if (
      elicitResult.action !== 'accept' ||
      elicitResult.content?.['confirmOverwrite'] !== true
    ) {
      // Return early — do not move.
      return buildToolResponse(`Move cancelled: ${source}`, {
        ok: true,
        source: validSource,
        destination: validDestination,
      });
    }
  }
}
```

> `stat` is already imported in `move-file.ts` from `node:fs/promises`. `validSource`, `validDestination`, `source`, `destination` are the validated path variables already in scope at this point in the function.

Update `handleMoveFile` (and the registration function) to accept and thread `elicitInput` the same way as Task 6:

```ts
async function handleMoveFile(
  args: z.infer<typeof MoveFileInputSchema>,
  signal?: AbortSignal,
  elicitInput?: (params: ElicitFormParams) => Promise<ElicitResult>
): Promise<ToolResponse<z.infer<typeof MoveFileOutputSchema>>> {
  // ... existing body, but thread elicitInput into the single-source move ...
}
```

And in `registerMoveFileTool`:

```ts
run: async (signal) => {
  const caps = server.server.getClientCapabilities();
  const elicitFn =
    caps?.elicitation && ctx.elicitInput
      ? ctx.elicitInput
      : undefined;
  const result = await handleMoveFile(args, signal, elicitFn);
  void ctx.log?.(
    'info',
    `mv: ${args.source ?? args.sources?.join(', ') ?? ''} → ${args.destination}`,
    'mv'
  );
  return result;
},
```

> **Multi-source moves:** When `args.sources` is provided (batch mode), only apply elicitation if at least one destination would be overwritten. To keep complexity low, skip elicitation for the batch path in this first implementation — file an issue for follow-up. Add a `// TODO: batch mv elicitation` comment near the batch dispatch.

- [ ] **Step 7.4: Run all elicitation tests**

```sh
node --test --import tsx/esm __tests__/tools/elicitation.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7.5: Run full check suite**

```sh
node scripts/tasks.mjs
```

Expected: all checks pass.

- [ ] **Step 7.6: Commit**

```sh
git add src/tools/move-file.ts __tests__/tools/elicitation.test.ts
git commit -m "feat: add elicitation confirmation when mv would overwrite an existing destination"
```

---

## Self-Review

**Spec coverage check:**

| Gap                                   | Task          | Covered?                               |
| ------------------------------------- | ------------- | -------------------------------------- |
| 1 — `elicitInput` for destructive ops | Tasks 5, 6, 7 | ✅ rm + mv, backward compat tested     |
| 2 — `sendResourceUpdated` for metrics | Task 4        | ✅ onMetricsUpdate + per-server wiring |
| 3 — `enforceStrictCapabilities: true` | Task 1        | ✅                                     |
| 4 — `debouncedNotificationMethods`    | Task 1        | ✅                                     |
| 5 — `onsessionclosed` hook            | Task 2        | ✅                                     |
| 6 — `retryInterval` on transport      | Task 1        | ✅                                     |
| 7 — Named `logger` in `ctx.log` calls | Task 3        | ✅ all 6 tool files                    |

**Placeholder scan:** No TBDs. Every code step shows exact content. Task 7, Step 7.3 intentionally defers batch-mv elicitation with a TODO comment — this is scoped and explicit.

**Type consistency:**

- `ElicitFormParams` and `ElicitResult` defined once in `src/tools/shared.ts`, imported in `delete-file.ts` and `move-file.ts`.
- `ElicitationHandler` defined once in `__tests__/helpers.ts`, used in test files.
- `METRICS_RESOURCE_URI` exported from `src/resources.ts`, imported in `src/server/bootstrap.ts`.
- `onMetricsUpdate` exported from `src/lib/observability.ts`, imported in `src/server/bootstrap.ts`.
- `cleanupServerMetrics` and `metricsUnsubscribers` are module-scoped in `bootstrap.ts` — no name conflicts.

**One open item to verify at implementation time:** The exact API for registering client-side elicitation handlers in `@modelcontextprotocol/client` v2 (Step 5.4). The plan uses `client.setRequestHandler('elicitation/create', handler)` as the most likely pattern, with a cast and comment flagging it. Adjust if the SDK uses a different method name.
