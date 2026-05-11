# Comprehensive Logging Review Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent wide-event logging across HTTP requests, regular tool execution, runtime failures, prompts, and resource subscriptions so review/debugging can rely on one structured event per important workflow boundary.

**Architecture:** Keep the existing diagnostics-channel based logger and MCP log routing intact, but add a thin wide-event layer in `src/core/observability.ts` that serializes canonical JSON events with stable environment metadata. Instrument completion boundaries rather than scattering new log lines: HTTP request completion, tool wrapper context handoff, runtime failure paths, and prompt/resource lifecycle handlers.

**Tech Stack:** TypeScript 6, Node 24, `@modelcontextprotocol/server` 2.0.0-alpha.2, Node `node:test` via `tsx`, existing diagnostics channel logging in `src/core/observability.ts`.

---

## File Structure

Files modified by this plan:

- `src/core/observability.ts` — add wide-event types/helpers, stable environment enrichment, and runtime-failure logging helpers.
- `src/transport.ts` — emit one HTTP completion event per request with status, outcome, kind, session, and duration.
- `src/tools/define.ts` — preserve full request context for regular tool calls so diagnostics can keep session and trace metadata.
- `src/index.ts` — route startup/shutdown/fatal process paths through the shared wide-event logger instead of raw `console.error`.
- `src/tasks.ts` — route fatal background-task failures through the shared wide-event logger.
- `src/prompts.ts` — emit prompt completion/error events with prompt name, outcome, and duration.
- `src/resources.ts` — emit subscribe/unsubscribe lifecycle events with resource URI and session context.
- `__tests__/unit/observability.test.ts` — verify wide-event serialization and runtime-failure helper behavior.
- `__tests__/http.test.ts` — verify HTTP completion logging on the transport boundary.
- `__tests__/unit/define-tool.test.ts` — verify regular tool wrappers keep `sessionId`, `_meta`, and `sendNotification`.
- `__tests__/prompts.test.ts` — verify prompt completion logs are emitted.
- `__tests__/resources.test.ts` — verify resource subscription logs are emitted.

Assumption for execution: do this work in a dedicated worktree before touching code in the main workspace.

---

### Task 1: Add a Canonical Wide-Event Helper

**Files:**

- Modify: `src/core/observability.ts`
- Test: `__tests__/unit/observability.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/unit/observability.test.ts`:

```ts
import { channel } from 'node:diagnostics_channel';

import { emitWideEvent, logRuntimeFailure } from '../../src/core/observability.js';

test('emitWideEvent emits canonical JSON with environment metadata', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string; level?: string } | undefined;

  logChannel.subscribe((msg: unknown) => {
    lastEvent = msg as { message?: string; level?: string };
  });

  emitWideEvent('info', {
    event: 'http_request_complete',
    transport: 'http',
    outcome: 'success',
    duration_ms: 12,
    session_id: 's-123',
    http_status: 200,
  });

  assert.equal(lastEvent?.level, 'info');
  const parsed = JSON.parse(lastEvent?.message ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['event'], 'http_request_complete');
  assert.equal(parsed['transport'], 'http');
  assert.equal(parsed['outcome'], 'success');
  assert.equal(parsed['session_id'], 's-123');
  assert.equal(parsed['http_status'], 200);
  assert.equal(parsed['service'], 'filesystem-mcp');
  assert.equal(parsed['runtime'], 'node');
  assert.ok(typeof parsed['service_version'] === 'string');
  assert.ok(typeof parsed['timestamp'] === 'string');
});

test('logRuntimeFailure emits a wide event with error details', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string; level?: string } | undefined;

  logChannel.subscribe((msg: unknown) => {
    lastEvent = msg as { message?: string; level?: string };
  });

  logRuntimeFailure('fatal', 'startup', 'parseArgs', new Error('boom'));

  assert.equal(lastEvent?.level, 'error');
  const parsed = JSON.parse(lastEvent?.message ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['event'], 'runtime_failure');
  assert.equal(parsed['reason'], 'fatal');
  assert.equal(parsed['scope'], 'startup');
  assert.equal(parsed['operation'], 'parseArgs');
  assert.equal(parsed['error_message'], 'boom');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test --import tsx/esm __tests__/unit/observability.test.ts`

Expected: FAIL with import or symbol errors because `emitWideEvent` and `logRuntimeFailure` do not exist yet.

- [ ] **Step 3: Add the minimal implementation in `src/core/observability.ts`**

Add these exports near the existing `Logger` and routing helpers:

```ts
import { pkgInfo } from '../pkg-info.js';

type WideEventLevel = LoggingLevel;

interface WideEventPayload {
  event: string;
  outcome?: 'success' | 'error' | 'cancelled' | 'rejected';
  duration_ms?: number;
  session_id?: string | null;
  traceparent?: string;
  [key: string]: unknown;
}

const STATIC_WIDE_EVENT_CONTEXT = {
  service: 'filesystem-mcp',
  service_version: pkgInfo.version,
  runtime: 'node',
};

function buildWideEvent(payload: WideEventPayload): Record<string, unknown> {
  return {
    ...STATIC_WIDE_EVENT_CONTEXT,
    timestamp: new Date().toISOString(),
    ...payload,
  };
}

export function emitWideEvent(level: WideEventLevel, payload: WideEventPayload): void {
  Logger.emit(level, JSON.stringify(buildWideEvent(payload)));
}

export function logRuntimeFailure(
  reason: string,
  scope: string,
  operation: string,
  error: unknown,
): void {
  emitWideEvent('error', {
    event: 'runtime_failure',
    reason,
    scope,
    operation,
    outcome: 'error',
    error_message: formatTransportError(error),
  });
}
```

Do not remove the existing `Logger` APIs in this task. This task only adds the canonical helper layer and keeps current log routing behavior stable.

- [ ] **Step 4: Run the focused test again**

Run: `node --test --import tsx/esm __tests__/unit/observability.test.ts`

Expected: PASS.

- [ ] **Step 5: Run quick static verification**

Run: `node scripts/tasks.mjs --quick`

Expected: format, lint, type-check, and knip pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/observability.ts __tests__/unit/observability.test.ts
git commit -m "feat(logging): add canonical wide-event helpers"
```

---

### Task 2: Emit One HTTP Completion Event Per Request

**Files:**

- Modify: `src/transport.ts`
- Test: `__tests__/http.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/http.test.ts`:

```ts
import { channel } from 'node:diagnostics_channel';

it('emits one http_request_complete event for initialize requests', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-log-'));
  const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
  servers.push(server);

  const logChannel = channel('filesystem-mcp:log');
  const messages: string[] = [];
  logChannel.subscribe((msg: unknown) => {
    const event = msg as { message?: string };
    if (typeof event.message === 'string') {
      messages.push(event.message);
    }
  });

  const port = getServerPort(server);
  const response = await rawHttpRequest({
    port,
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'http-test', version: '1.0.0' },
      },
    }),
  });

  assert.equal(response.statusCode, 200);

  const completion = messages
    .map((message) => {
      try {
        return JSON.parse(message) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.['event'] === 'http_request_complete');

  assert.ok(completion, 'expected http_request_complete event');
  assert.equal(completion?.['transport'], 'http');
  assert.equal(completion?.['method'], 'POST');
  assert.equal(completion?.['jsonrpc_method'], 'initialize');
  assert.equal(completion?.['http_status'], 200);
  assert.equal(completion?.['outcome'], 'success');
  assert.ok(typeof completion?.['duration_ms'] === 'number');
});
```

- [ ] **Step 2: Run the focused transport test to verify it fails**

Run: `node --test --import tsx/esm __tests__/http.test.ts`

Expected: FAIL because no `http_request_complete` event is emitted yet.

- [ ] **Step 3: Instrument `src/transport.ts` with a completion wrapper**

Add a small helper and use it from both request handlers:

```ts
import { performance } from 'node:perf_hooks';

import { emitWideEvent } from './core/observability.js';

function emitHttpCompletionEvent(input: {
  method: string;
  path: string;
  kind: JsonRpcKind;
  jsonrpcMethod?: string;
  sessionId?: string;
  httpStatus: number;
  outcome: 'success' | 'error' | 'rejected';
  startedAt: number;
}): void {
  emitWideEvent(input.outcome === 'success' ? 'info' : 'error', {
    event: 'http_request_complete',
    transport: 'http',
    method: input.method,
    path: input.path,
    request_kind: input.kind,
    jsonrpc_method: input.jsonrpcMethod,
    session_id: input.sessionId ?? null,
    http_status: input.httpStatus,
    outcome: input.outcome,
    duration_ms: performance.now() - input.startedAt,
  });
}
```

Then wrap `handlePostMcp()` and `handleGetOrDeleteMcp()` in `try/finally`, keep a local `httpStatus` variable, and call `emitHttpCompletionEvent(...)` before each function exits. Use `message.method` when the JSON-RPC message is a request or notification; omit `jsonrpc_method` otherwise.

- [ ] **Step 4: Re-run the transport test**

Run: `node --test --import tsx/esm __tests__/http.test.ts`

Expected: PASS.

- [ ] **Step 5: Run quick static verification**

Run: `node scripts/tasks.mjs --quick`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/transport.ts __tests__/http.test.ts
git commit -m "feat(logging): add canonical HTTP completion events"
```

---

### Task 3: Preserve Session and Trace Context for Regular Tool Calls

**Files:**

- Modify: `src/tools/define.ts`
- Modify: `__tests__/unit/define-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Extend `__tests__/unit/define-tool.test.ts` with richer request metadata and a new assertion:

```ts
type CapturedHandler = (
  args: TestInput,
  extra: {
    sessionId?: string;
    mcpReq: {
      signal: AbortSignal;
      _meta?: Record<string, unknown>;
      notify: (notification: unknown) => Promise<void>;
      log: (level: string, data: unknown, logger?: string) => Promise<void>;
      elicitInput: (params: unknown) => Promise<unknown>;
    };
  },
) => Promise<Record<string, unknown>>;

function fakeMcpReq() {
  const notifications: unknown[] = [];
  return {
    signal: new AbortController().signal,
    _meta: {
      'io.opentelemetry/traceparent': '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    },
    notifications,
    notify: async (notification: unknown) => {
      notifications.push(notification);
    },
    log: async () => undefined,
    elicitInput: async () => ({ action: 'cancel' as const }),
  };
}

test('defineTool: regular tools keep session, trace metadata, and notifications', async () => {
  let capturedCtx: ToolContext | undefined;
  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      capturedCtx = ctx;
      await ctx.sendNotification?.({ method: 'notifications/test', params: { ok: true } });
      return buildToolResponse<TestOutput>('test', { ok: true, result: 'success' });
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler);

  const req = fakeMcpReq();
  await capture.handler({ message: 'hello' }, { sessionId: 'session-42', mcpReq: req });

  assert.equal(capturedCtx?.sessionId, 'session-42');
  assert.equal(
    capturedCtx?._meta?.['io.opentelemetry/traceparent'],
    req._meta?.['io.opentelemetry/traceparent'],
  );
  assert.equal(req.notifications.length, 1);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test --import tsx/esm __tests__/unit/define-tool.test.ts`

Expected: FAIL because `ctx.sessionId`, `ctx._meta`, or `ctx.sendNotification` are missing on the regular tool path.

- [ ] **Step 3: Replace the ad hoc context adapter in `src/tools/define.ts`**

Update the regular tool registration branch to use the full server context shape instead of rebuilding a partial object:

```ts
import { toToolContext } from './_helpers.js';

const serverCtxHandler = async (
  args: unknown,
  extra: {
    sessionId?: string;
    mcpReq: {
      signal: AbortSignal;
      _meta?: Record<string, unknown>;
      notify: (notification: Notification) => Promise<void>;
      log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
      elicitInput: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
    };
  },
): Promise<CallToolResult> =>
  coreHandler(
    args,
    toToolContext({
      sessionId: extra.sessionId,
      mcpReq: extra.mcpReq,
    } as ServerContext),
  );
```

Do not change task-capable tool registration in this task. The scope here is regular `registerTool(...)` behavior only.

- [ ] **Step 4: Re-run the focused test**

Run: `node --test --import tsx/esm __tests__/unit/define-tool.test.ts`

Expected: PASS.

- [ ] **Step 5: Run quick static verification**

Run: `node scripts/tasks.mjs --quick`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/define.ts __tests__/unit/define-tool.test.ts
git commit -m "fix(logging): preserve full request context for regular tool calls"
```

---

### Task 4: Route Runtime Failures Through the Shared Logger

**Files:**

- Modify: `src/index.ts`
- Modify: `src/tasks.ts`
- Test: `__tests__/unit/observability.test.ts`

- [ ] **Step 1: Write the failing test**

Append this narrow helper-level assertion to `__tests__/unit/observability.test.ts`:

```ts
test('logRuntimeFailure marks failures as error outcomes', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string } | undefined;

  logChannel.subscribe((msg: unknown) => {
    lastEvent = msg as { message?: string };
  });

  logRuntimeFailure('shutdown_timeout', 'process', 'shutdown', 'timed out');

  const parsed = JSON.parse(lastEvent?.message ?? '{}') as Record<string, unknown>;
  assert.equal(parsed['event'], 'runtime_failure');
  assert.equal(parsed['outcome'], 'error');
  assert.equal(parsed['scope'], 'process');
  assert.equal(parsed['operation'], 'shutdown');
  assert.equal(parsed['error_message'], 'timed out');
});
```

- [ ] **Step 2: Run the focused test to verify it fails or is incomplete**

Run: `node --test --import tsx/esm __tests__/unit/observability.test.ts`

Expected: if Task 1 is complete, this passes immediately. If so, proceed and treat this step as confirming the helper contract before rewiring call sites.

- [ ] **Step 3: Replace raw `console.error` call sites in `src/index.ts` and `src/tasks.ts`**

In `src/index.ts`, replace the direct stderr writes with `logRuntimeFailure(...)` calls:

```ts
logRuntimeFailure('shutdown_timeout', 'process', 'shutdown', `Shutdown timed out (${reason})`);
logRuntimeFailure('shutdown_error', 'process', 'shutdown', formatUnknownErrorMessage(error));
logRuntimeFailure('cli_exit', 'startup', 'parse_args', error.message);
logRuntimeFailure(
  'unhandled_rejection',
  'process',
  'unhandledRejection',
  formatUnknownErrorMessage(reason),
);
logRuntimeFailure('uncaught_exception', 'process', 'uncaughtException', error);
logRuntimeFailure('fatal', 'startup', 'main', formatUnknownErrorMessage(error));
```

In `src/tasks.ts`, replace the orchestrator fallback log with:

```ts
logRuntimeFailure('background_task_fatal', 'task_orchestrator', options.toolName, error);
```

Keep existing exit-code behavior unchanged.

- [ ] **Step 4: Run targeted tests and a quick smoke check**

Run: `node --test --import tsx/esm __tests__/unit/observability.test.ts`

Run: `node --test --import tsx/esm __tests__/unit/task-orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 5: Run quick static verification**

Run: `node scripts/tasks.mjs --quick`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/tasks.ts __tests__/unit/observability.test.ts
git commit -m "refactor(logging): route runtime failures through wide-event logger"
```

---

### Task 5: Emit Prompt and Resource Lifecycle Events

**Files:**

- Modify: `src/prompts.ts`
- Modify: `src/resources.ts`
- Test: `__tests__/prompts.test.ts`
- Test: `__tests__/resources.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/prompts.test.ts`:

```ts
import { channel } from 'node:diagnostics_channel';

it('emits prompt_complete events for successful prompt resolution', async () => {
  const env = await createPromptEnv();
  cleanups.push(env.cleanup);

  const logChannel = channel('filesystem-mcp:log');
  const messages: string[] = [];
  logChannel.subscribe((msg: unknown) => {
    const event = msg as { message?: string };
    if (typeof event.message === 'string') messages.push(event.message);
  });

  await env.client.getPrompt({ name: 'get-help', arguments: {} });

  const completion = messages
    .map((message) => {
      try {
        return JSON.parse(message) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((event) => event?.['event'] === 'prompt_complete');

  assert.ok(completion);
  assert.equal(completion?.['prompt_name'], 'get-help');
  assert.equal(completion?.['outcome'], 'success');
  assert.ok(typeof completion?.['duration_ms'] === 'number');
});
```

Append to `__tests__/resources.test.ts`:

```ts
import { channel } from 'node:diagnostics_channel';

it('emits resource_subscription events for subscribe and unsubscribe', async () => {
  const env = await createDiscoveryEnv();
  cleanups.push(env.cleanup);

  const logChannel = channel('filesystem-mcp:log');
  const messages: string[] = [];
  logChannel.subscribe((msg: unknown) => {
    const event = msg as { message?: string };
    if (typeof event.message === 'string') messages.push(event.message);
  });

  const uri = 'filesystem-mcp://file/' + encodeURIComponent(__filename);
  await env.client.subscribeResource({ uri });
  await env.client.unsubscribeResource({ uri });

  const events = messages
    .map((message) => {
      try {
        return JSON.parse(message) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is Record<string, unknown> => Boolean(event))
    .filter((event) => event['event'] === 'resource_subscription');

  assert.equal(events.length, 2);
  assert.equal(events[0]?.['action'], 'subscribe');
  assert.equal(events[1]?.['action'], 'unsubscribe');
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/prompts.test.ts`

Run: `node --test --import tsx/esm __tests__/resources.test.ts`

Expected: FAIL because the prompt/resource handlers do not emit these events yet.

- [ ] **Step 3: Add completion/error event emission to `src/prompts.ts` and subscription event emission to `src/resources.ts`**

In `src/prompts.ts`, wrap the existing completion logging in `emitWideEvent(...)`:

```ts
import { emitWideEvent } from './core/observability.js';

function logPromptResolution(input: {
  promptName: string;
  displayName: string;
  startedAt: number;
  outcome: 'success' | 'error';
  errorMessage?: string;
}): void {
  emitWideEvent(input.outcome === 'success' ? 'info' : 'error', {
    event: 'prompt_complete',
    prompt_name: input.promptName,
    display_name: input.displayName,
    outcome: input.outcome,
    duration_ms: Date.now() - input.startedAt,
    ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
  });
}
```

Call it for both the success and thrown-error paths inside `wrapHandler(...)`.

In `src/resources.ts`, emit one event inside each handler:

```ts
import { emitWideEvent } from './core/observability.js';

emitWideEvent('info', {
  event: 'resource_subscription',
  action: 'subscribe',
  uri: requestedResource.toString(),
  outcome: 'success',
});

emitWideEvent('info', {
  event: 'resource_subscription',
  action: 'unsubscribe',
  uri: canonical,
  outcome: 'success',
});
```

- [ ] **Step 4: Re-run the focused tests**

Run: `node --test --import tsx/esm __tests__/prompts.test.ts`

Run: `node --test --import tsx/esm __tests__/resources.test.ts`

Expected: PASS.

- [ ] **Step 5: Run quick static verification**

Run: `node scripts/tasks.mjs --quick`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompts.ts src/resources.ts __tests__/prompts.test.ts __tests__/resources.test.ts
git commit -m "feat(logging): add prompt and resource lifecycle events"
```

---

## Final Verification

- [ ] **Step 1: Run the full fast suite**

Run: `node scripts/tasks.mjs --quick`

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`

Expected: PASS.

- [ ] **Step 3: Inspect the diff before merge**

Run: `git diff --stat`

Expected: only the logging, transport, wrapper, and test files listed above are changed.

---

## Self-Review

**Spec coverage:**

- HIGH #1 (canonical wide events): Task 1.
- HIGH #2 (HTTP completion event): Task 2.
- HIGH #3 (regular tool context loss): Task 3.
- MEDIUM #1 (bootstrap/process runtime failures): Task 4.
- MEDIUM #2 (task orchestrator fatal logging): Task 4.
- LOW #1 (prompt/resource lifecycle visibility): Task 5.

**Placeholder scan:**

- No `TBD`, `TODO`, or "implement later" placeholders remain.
- Each task includes concrete file paths, code snippets, commands, and expected outcomes.

**Type consistency:**

- Canonical wide-event helper name is `emitWideEvent` throughout.
- Runtime failure helper name is `logRuntimeFailure` throughout.
- Canonical event fields stay snake_case throughout: `event`, `outcome`, `duration_ms`, `session_id`, `http_status`, `error_message`, `prompt_name`.

Plan complete and saved to `docs/superpowers/plans/2026-05-11-comprehensive-logging-review-followups.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
