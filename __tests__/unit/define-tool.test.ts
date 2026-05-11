// define-tool.test.ts — tests for defineTool() from src/tools/define.ts
import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/core/errors.js';
import type { PathGuard } from '../../src/core/path.js';
import type { ResourceStore } from '../../src/core/store.js';
import { buildToolResponse } from '../../src/tools/_helpers.js';
import { defineTool } from '../../src/tools/define.js';

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
type CapturedHandler = (
  args: TestInput,
  extra: {
    mcpReq: {
      signal: AbortSignal;
      log: (level: string, data: unknown, logger?: string) => Promise<void>;
      elicitInput: (params: unknown) => Promise<unknown>;
    };
  },
) => Promise<Record<string, unknown>>;

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
  return {
    signal: new AbortController().signal,
    log: async () => undefined,
    elicitInput: async () => ({ action: 'cancel' as const }),
  };
}

const BASE_DEF = {
  name: 'test-tool',
  title: 'Test Tool',
  description: 'A tool for testing defineTool',
  input: TestInputSchema,
  output: TestOutputSchema,
  annotations: 'readOnly' as const,
  task: 'forbidden' as const,
  run: async () => buildToolResponse<TestOutput>('test', { ok: true, result: 'success' }),
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
      return buildToolResponse<TestOutput>('test', { ok: true, result: 'success' });
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  const result = await capture.handler({ message: 'hello' }, { mcpReq: fakeMcpReq() });
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
  await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() });
});

test('defineTool: extended input schema works', async (): Promise<void> => {
  const ExtendedInputSchema = TestInputSchema.extend({ path: z.string().optional() });
  const tool = defineTool({
    ...BASE_DEF,
    input: ExtendedInputSchema,
    run: async () => buildToolResponse<TestOutput>('test', { ok: true, result: 'success' }),
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler, 'handler was captured');
  await capture.handler({ message: 'test', path: '/some/path' } as TestInput, {
    mcpReq: fakeMcpReq(),
  });
});

test('defineTool: progressLabel option is accepted', (): void => {
  const tool = defineTool({
    ...BASE_DEF,
    progressLabel: (args) => `Processing: ${args.message}`,
  });
  tool.register(makeTestDeps(makeMockServer()));
  assert.ok(tool.name, 'tool was created');
});

test('defineTool: all annotation types are accepted', (): void => {
  for (const annotations of ['readOnly', 'idempotentWrite', 'destructiveWrite'] as const) {
    const tool = defineTool({ ...BASE_DEF, annotations });
    tool.register(makeTestDeps(makeMockServer()));
    assert.equal(tool.annotations, annotations);
  }
});

test('defineTool: handler returns not-initialized error when guard fails', async (): Promise<void> => {
  const tool = defineTool(BASE_DEF);
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture), false));
  assert.ok(capture.handler, 'handler was captured');
  const result = await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() });
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
  const result = await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() });
  assert.ok(result.isError, 'result is an error');
  assert.equal(result.errorCode, ErrorCode.UNKNOWN);
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
  const result = await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() });
  assert.ok(result.isError);
  assert.equal(result.errorCode, ErrorCode.TIMEOUT);
});

test('defineTool: resourceStore is injected into ToolCtx', async (): Promise<void> => {
  let capturedResourceStore: unknown;
  const tool = defineTool({
    ...BASE_DEF,
    run: async (_args, ctx) => {
      capturedResourceStore = ctx.resourceStore;
      return buildToolResponse<TestOutput>('test', { ok: true, result: 'success' });
    },
  });
  const capture: HandlerCapture = { handler: undefined };
  const mockResourceStore = { mock: true } as unknown as ResourceStore;
  tool.register({ ...makeTestDeps(makeMockServer(capture)), resourceStore: mockResourceStore });
  assert.ok(capture.handler, 'handler was captured');
  await capture.handler({ message: 'test' }, { mcpReq: fakeMcpReq() });
  assert.equal(capturedResourceStore, mockResourceStore);
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
