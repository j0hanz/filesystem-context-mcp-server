import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { test } from 'node:test';

import * as z from 'zod/v4';

import { ErrorCode } from '../../src/core/errors.js';
import type { PathGuard } from '../../src/core/path.js';
import type { ResourceStore } from '../../src/core/store.js';
import { defineTool } from '../../src/tools/define.js';

// define-tool.test.ts — tests for defineTool() from src/tools/define.ts
process.env['NODE_ENV'] = 'test';

const TestInputSchema = z.strictObject({
  message: z.string().describe('A test message'),
});

const TestOutputSchema = z.strictObject({
  ok: z.boolean(),
  result: z.string(),
});

type TestInput = z.infer<typeof TestInputSchema>;
type TestOutput = z.infer<typeof TestOutputSchema>;

// The serverCtxHandler signature registered via registerTool
type CapturedHandler = (args: TestInput, extra: ServerContext) => Promise<Record<string, unknown>>;

interface HandlerCapture {
  handler: CapturedHandler | undefined;
}

function makeMockServer(capture?: HandlerCapture): McpServer {
  return {
    registerTool: (_name: string, _schema: unknown, handler: unknown): void => {
      if (capture) capture.handler = handler as CapturedHandler;
    },
  } as unknown as McpServer;
}

function makeTestDeps(server: McpServer, isInitialized = true) {
  return {
    server,
    pathGuard: null as unknown as PathGuard,
    resourceStore: undefined as ResourceStore | undefined,
    isInitialized: () => isInitialized,
  };
}

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

function fakeMcpReqWithProgressToken(progressToken: string) {
  const req = fakeMcpReq();
  return {
    ...req,
    _meta: {
      ...req._meta,
      progressToken,
    },
  };
}

function filterNotificationsByMethod(
  notifications: unknown[],
  method: string,
): { method: string; params?: unknown }[] {
  return notifications.filter(
    (notification): notification is { method: string; params?: unknown } => {
      if (!notification || typeof notification !== 'object') return false;
      const candidate = notification as { method?: unknown; params?: unknown };
      return candidate.method === method;
    },
  );
}

function getProgressPayloads(
  notifications: unknown[],
): { progressToken?: unknown; progress?: unknown; total?: unknown; message?: unknown }[] {
  return filterNotificationsByMethod(notifications, 'notifications/progress').map(
    (notification) => {
      if (!notification.params || typeof notification.params !== 'object') return {};
      return notification.params;
    },
  );
}

async function runCapturedHandler(
  capture: HandlerCapture,
  args: TestInput,
  serverContext: ServerContext,
): Promise<Record<string, unknown>> {
  assert.ok(capture.handler, 'handler was captured');
  return capture.handler(args, serverContext);
}

const BASE_DEF = {
  name: 'test-tool',
  title: 'Test Tool',
  description: 'A tool for testing defineTool',
  input: TestInputSchema,
  output: TestOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  task: 'forbidden' as const,
  run: async () => ({ structured: { ok: true as const, result: 'success' }, text: 'test' }),
};

test('defineTool: returns DefinedTool with name and register', (): void => {
  const tool = defineTool(BASE_DEF);
  assert.equal(tool.name, 'test-tool', 'name is set correctly');
  assert.equal(typeof tool.register, 'function', 'register is a function');
});

test('defineTool: registers a standard tool with server.registerTool', (): void => {
  let registerToolCalled = false;
  let registeredToolName: string | undefined;
  const mockServer = {
    registerTool: (name: string, _schema: unknown, _handler: unknown): void => {
      registerToolCalled = true;
      registeredToolName = name;
    },
  } as unknown as McpServer;
  const tool = defineTool(BASE_DEF);
  tool.register(makeTestDeps(mockServer));
  assert.ok(registerToolCalled, 'server.registerTool was called');
  assert.equal(registeredToolName, 'test-tool', 'registered with correct name');
});

test('defineTool: run receives args and ToolCtx with signal', async (): Promise<void> => {
  const runInputs: TestInput[] = [];
  const runSignals: AbortSignal[] = [];
  const tool = defineTool({
    ...BASE_DEF,
    run: async (args, ctx) => {
      runInputs.push(args);
      runSignals.push(ctx.signal);
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  const result = await capture.handler({ message: 'hello' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.equal((result.structuredContent as TestOutput).result, 'success');
  assert.equal(runInputs.length, 1);
  assert.deepEqual(runInputs[0], { message: 'hello' });
  assert.ok(runSignals[0] instanceof AbortSignal, 'ctx.signal is an AbortSignal');
});

test('defineTool: tool runs without crash on basic invocation', async (): Promise<void> => {
  const tool = defineTool(BASE_DEF);
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() } as unknown as ServerContext);
});

test('defineTool: extended input schema works', async (): Promise<void> => {
  const ExtendedInputSchema = TestInputSchema.extend({ path: z.string().optional() });
  const tool = defineTool({
    ...BASE_DEF,
    input: ExtendedInputSchema,
    run: async () => ({ structured: { ok: true as const, result: 'success' }, text: 'test' }),
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  await capture.handler(
    { message: 'test', path: '/some/path' } as TestInput,
    { mcpReq: fakeMcpReq() } as unknown as ServerContext,
  );
});

test('defineTool: progress and progressDone options are accepted', (): void => {
  const tool = defineTool({
    ...BASE_DEF,
    progress: (args) => ({ label: 'Test', subject: args.message }),
    progressDone: (_args, result) => ({ detail: result.result }),
  });
  tool.register(makeTestDeps(makeMockServer()));
  assert.ok(tool.name, 'tool was created');
});

test('defineTool: no progress token => no progress notifications are emitted', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const request = fakeMcpReq();
  await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: request,
  } as unknown as ServerContext);

  const progressNotifications = getProgressPayloads(request.notifications);
  assert.equal(progressNotifications.length, 0);
});

test('defineTool: with progress token and one tick => emits start + tick + done notifications with message field', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const request = fakeMcpReqWithProgressToken('token-1');
  await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: request,
  } as unknown as ServerContext);

  const progressPayloads = getProgressPayloads(request.notifications);
  // start (current=0) + tick (current=1) + done (current=2)
  assert.equal(progressPayloads.length, 3);
  assert.ok(progressPayloads.every((p) => p.progressToken === 'token-1'));
  assert.ok(
    progressPayloads.every((p) => typeof p.message === 'string' && p.message.length > 0),
    'all notifications must carry a message string',
  );
  // monotonic
  for (let i = 1; i < progressPayloads.length; i++) {
    assert.ok((progressPayloads[i]?.progress ?? 0) >= (progressPayloads[i - 1]?.progress ?? 0));
  }
  // final notification signals completion: current === total
  const last = progressPayloads[progressPayloads.length - 1];
  assert.equal(last?.progress, last?.total);
});

test('defineTool: done progress message does not carry "done:" prefix', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    progress: (_args) => ({ label: 'Test', subject: 'item' }),
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const request = fakeMcpReqWithProgressToken('done-prefix-token');
  await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: request,
  } as unknown as ServerContext);

  const progressPayloads = getProgressPayloads(request.notifications);
  const doneMessage = progressPayloads[progressPayloads.length - 1]?.message;
  const doneMsg = typeof doneMessage === 'string' ? doneMessage : '';
  assert.ok(!doneMsg.startsWith('done:'), `expected no "done:" prefix, got: ${doneMsg}`);
  assert.ok(doneMsg.startsWith('Test:'), `expected message to start with label, got: ${doneMsg}`);
});

test('defineTool: applies progressDone augmentation to done message text', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    progress: (_args) => ({ label: 'Test', subject: 'item' }),
    progressDone: (_args, _result) => ({ detail: '1 match' }),
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const request = fakeMcpReqWithProgressToken('token-ignore-progressdone');
  await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: request,
  } as unknown as ServerContext);

  const progressPayloads = getProgressPayloads(request.notifications);
  const doneMessage = progressPayloads[progressPayloads.length - 1]?.message;
  const doneMsg = typeof doneMessage === 'string' ? doneMessage : '';
  assert.equal(doneMsg, 'Test: item · 1 match');
});

test('defineTool: delayed tick after completion is suppressed, only start+done notifications emitted', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      setTimeout(() => {
        ctx.onProgress?.({ current: 1, total: 1 });
      }, 5);
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const request = fakeMcpReqWithProgressToken('late-tick-token');
  const result = await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: request,
  } as unknown as ServerContext);

  assert.equal((result.structuredContent as TestOutput).result, 'success');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

  const progressPayloads = getProgressPayloads(request.notifications);
  // start (current=0) + done (current=1); the delayed tick is suppressed by progressClosed
  assert.equal(progressPayloads.length, 2);
  assert.equal(progressPayloads[0]?.progress, 0);
  // final: current === total
  const last = progressPayloads[progressPayloads.length - 1];
  assert.equal(last?.progress, last?.total);
});

test('defineTool: detached progress side effects tolerate rejections without unhandled rejection', async (t): Promise<void> => {
  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      ctx.log?.('info', { stage: 'begin' });
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const failingRequest = {
    ...fakeMcpReqWithProgressToken('token-reject'),
    log: async (): Promise<void> => {
      throw new Error('log rejected');
    },
    notify: async (): Promise<void> => {
      throw new Error('notification rejected');
    },
  };

  const result = await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: failingRequest,
    task: {
      id: 'task-reject',
      store: {
        updateTaskStatus: async (
          _taskId: string,
          _status: unknown,
          statusMessage?: unknown,
        ): Promise<void> => {
          if (typeof statusMessage === 'string' && /\btick\b/i.test(statusMessage)) {
            throw new Error('tick rejected');
          }
        },
      },
    },
  } as unknown as ServerContext);

  assert.equal((result.structuredContent as TestOutput).result, 'success');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

  assert.equal(unhandledRejections.length, 0);
});

test('defineTool: non-task progress notification rejection does not produce unhandled rejection', async (t): Promise<void> => {
  const unhandledRejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const failingRequest = {
    ...fakeMcpReqWithProgressToken('token-reject-notify'),
    notify: async (): Promise<void> => {
      throw new Error('notification rejected');
    },
  };

  const result = await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: failingRequest,
  } as unknown as ServerContext);

  assert.equal((result.structuredContent as TestOutput).result, 'success');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });

  assert.equal(unhandledRejections.length, 0);
});

test('defineTool: tool_execution wide event uses SDK-aligned progress/status counters', async (t): Promise<void> => {
  const logChannel = channel('filesystem-mcp:log');
  const toolExecutionMessages: string[] = [];
  const onLog = (msg: unknown): void => {
    if (!msg || typeof msg !== 'object') return;
    const event = msg as { level?: unknown; message?: unknown };
    if (event.level !== 'info' || typeof event.message !== 'string') return;
    if (!event.message.includes('event=tool_execution')) return;
    if (!event.message.includes('tool_name=test-tool')) return;
    toolExecutionMessages.push(event.message);
  };

  logChannel.subscribe(onLog);
  t.after(() => {
    logChannel.unsubscribe(onLog);
  });

  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: fakeMcpReqWithProgressToken('counter-token'),
  } as unknown as ServerContext);

  assert.ok(toolExecutionMessages.length >= 1, 'expected tool_execution wide event log message');
  const message = toolExecutionMessages[toolExecutionMessages.length - 1];

  assert.ok(message.includes('tool_progress_ticks=1'));
  // start + tick + done = 3 notifications, each carrying a message string
  assert.ok(message.includes('progress_notifications_emitted=3'));
  assert.equal(message.includes('task_status_updates_requested='), false);
});

test('defineTool: annotation objects are accepted', (): void => {
  const cases = [
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ] as const;

  for (const annotations of cases) {
    const tool = defineTool({ ...BASE_DEF, annotations });
    tool.register(makeTestDeps(makeMockServer()));
    assert.deepEqual(tool.annotations, annotations);
  }
});

test('defineTool: handler returns not-initialized error when guard fails', async (): Promise<void> => {
  const tool = defineTool(BASE_DEF);
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture), false));
  assert.ok(capture.handler, 'handler was captured');
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.ok(result.isError, 'result is an error when not initialized');
});

test('defineTool: handler returns formatted error on thrown exception', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    run: async () => {
      throw new Error('Test error');
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.ok(result.isError, 'result is an error');
  assert.equal('errorCode' in result, false);
  assert.match((result.content?.[0] as { text?: string } | undefined)?.text ?? '', /UNKNOWN/i);
  assert.match((result.content?.[0] as { text?: string } | undefined)?.text ?? '', /Test error/i);
});

test('defineTool: defaultErrorCode is used in error responses', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    defaultErrorCode: ErrorCode.TIMEOUT,
    run: async () => {
      throw new Error('Test error');
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.ok(result.isError);
  assert.equal('errorCode' in result, false);
  assert.match((result.content?.[0] as { text?: string } | undefined)?.text ?? '', /TIMEOUT/i);
  assert.match((result.content?.[0] as { text?: string } | undefined)?.text ?? '', /Test error/i);
});

test('defineTool: resourceStore is injected into ToolCtx', async (): Promise<void> => {
  let capturedResourceStore: unknown;
  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      capturedResourceStore = ctx.resourceStore;
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  const mockResourceStore = { mock: true } as unknown as ResourceStore;
  tool.register({ ...makeTestDeps(makeMockServer(capture)), resourceStore: mockResourceStore });
  assert.ok(capture.handler, 'handler was captured');
  await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() } as unknown as ServerContext);
  assert.equal(capturedResourceStore, mockResourceStore);
});

test('defineTool: regular tools keep session, trace metadata, and notifications', async (): Promise<void> => {
  let capturedSessionId: string | undefined;
  let capturedTraceparent: string | undefined;

  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      capturedSessionId = ctx.sessionId;
      capturedTraceparent = ctx._meta?.['io.opentelemetry/traceparent'];
      await ctx.sendNotification?.({ method: 'notifications/test', params: { ok: true } });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');

  const requestContext = {
    sessionId: 'session-42',
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext;

  const result = await capture.handler({ message: 'hello' }, requestContext);
  assert.equal((result.structuredContent as TestOutput).result, 'success');
  assert.equal(capturedSessionId, 'session-42');
  assert.equal(capturedTraceparent, '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
  assert.equal((requestContext.mcpReq as { notifications?: unknown[] }).notifications?.length, 1);
});

test('defineTool: inputSchema and outputSchema are present', (): void => {
  const tool = defineTool(BASE_DEF);
  assert.ok(
    typeof tool.inputSchema === 'object' && tool.inputSchema !== null,
    'inputSchema is an object',
  );
  assert.ok(
    typeof tool.outputSchema === 'object' && tool.outputSchema !== null,
    'outputSchema is an object',
  );
});

test('display name fallback: uses title when progress metadata is not provided', async (): Promise<void> => {
  const { getDisplayName } = (await import('@modelcontextprotocol/server')) as {
    getDisplayName: (m: { title?: string; name: string }) => string;
  };
  const tool = defineTool(BASE_DEF);
  assert.equal(getDisplayName(tool), 'Test Tool');
  assert.notEqual(getDisplayName(tool), tool.name);
});

test('defineTool: RunResult with text and resources flows through to CallToolResult', async (): Promise<void> => {
  const resourceLink = {
    type: 'resource_link' as const,
    uri: 'filesystem-mcp://result/abc',
    name: 'file.ts',
    mimeType: 'text/plain',
    size: 10,
  };
  const tool = defineTool({
    ...BASE_DEF,
    run: async () => ({
      structured: { ok: true as const, result: 'new-shape' },
      text: 'summary: file.ts',
      resources: [resourceLink],
    }),
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler);
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.equal((result.structuredContent as TestOutput).result, 'new-shape');
  assert.equal(result.content[0]?.type, 'text');
  assert.equal((result.content[0] as { type: string; text: string }).text, 'summary: file.ts');
  assert.equal(result.content[1], resourceLink);
});

test('defineTool: RunResult without text falls back to JSON.stringify(structured)', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    run: async () => ({
      structured: { ok: true as const, result: 'json-fallback' },
    }),
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler);
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.equal((result.structuredContent as TestOutput).result, 'json-fallback');
  assert.equal(result.content.length, 1);
  const text = (result.content[0] as { type: string; text: string }).text;
  assert.equal(text, JSON.stringify({ ok: true, result: 'json-fallback' }));
});
