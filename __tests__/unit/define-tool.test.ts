import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/lib/errors.js';
import type { PathGuard } from '../../src/lib/path-guard.js';
import type { ResourceStore } from '../../src/lib/resource-store.js';
import type { ToolContract } from '../../src/tools/contract.js';
import { defineTool } from '../../src/tools/define-tool.js';
import type { HandlerContext, ToolResult } from '../../src/tools/shared.js';
import { buildToolResponse } from '../../src/tools/shared.js';

const TestInputSchema = z.strictObject({
  message: z.string().describe('A test message'),
});

const TestOutputSchema = z.strictObject({
  ok: z.boolean(),
  result: z.string(),
});

type TestInput = z.infer<typeof TestInputSchema>;
type TestOutput = z.infer<typeof TestOutputSchema>;

type MockHandler = (
  args: TestInput,
  ctx: Record<string, unknown>
) => Promise<ToolResult<TestOutput>>;

const TEST_CONTRACT: ToolContract = {
  name: 'test-tool',
  title: 'Test Tool',
  description: 'A tool for testing defineTool',
  inputSchema: TestInputSchema,
  outputSchema: TestOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  taskSupport: 'forbidden',
} as const;

interface CapturedHandler {
  handler: MockHandler | undefined;
}

function createMockServer(captured: CapturedHandler): McpServer {
  return {
    registerTool: (_name: string, _schema: unknown, handler: unknown): void => {
      captured.handler = handler as MockHandler;
    },
  } as unknown as McpServer;
}

test('defineTool: returns DefinedTool with contract and register', (): void => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
  });

  assert.equal(tool.contract, TEST_CONTRACT, 'contract is passed by reference');
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

  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
  });

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(registerToolCalled, 'server.registerTool was called');
  assert.equal(registeredToolName, 'test-tool', 'registered with correct name');
});

test('defineTool: run receives args and HandlerContext with signal', async (): Promise<void> => {
  const runInputs: TestInput[] = [];
  const runContexts: HandlerContext[] = [];

  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async (args, ctx) => {
      runInputs.push(args);
      runContexts.push(ctx);
      return buildToolResponse('test', { ok: true, result: 'success' });
    },
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  const result = await captured.handler(
    {
      message: 'test message',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.ok(!result.isError, 'result is not an error');
  assert.equal(result.structuredContent.result, 'success');
  assert.equal(runInputs.length, 1);
  assert.deepEqual(runInputs[0], { message: 'test message' });
  assert.ok(runContexts.length > 0);
  const firstCtx = runContexts[0];
  assert.ok(firstCtx);
  assert.ok(firstCtx.signal, 'context has signal');
});

test('defineTool: default diagnosticsContext extracts path from args', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  await captured.handler(
    {
      message: 'test',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );
});

test('defineTool: custom diagnosticsContext is used', async (): Promise<void> => {
  type ExtendedInput = TestInput & { path?: string };

  const tool = defineTool<ExtendedInput, TestOutput>({
    contract: {
      ...TEST_CONTRACT,
      inputSchema: TestInputSchema.extend({
        path: z.string().optional(),
      }),
    },
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
    diagnosticsContext: (args: ExtendedInput) =>
      args.path ? { path: args.path } : {},
  });

  let capturedHandler:
    | ((
        args: ExtendedInput,
        ctx: Record<string, unknown>
      ) => Promise<ToolResult<TestOutput>>)
    | undefined;
  const mockServer = {
    registerTool: (
      _name: string,
      _schema: unknown,
      handler: (
        args: ExtendedInput,
        ctx: Record<string, unknown>
      ) => Promise<ToolResult<TestOutput>>
    ): void => {
      capturedHandler = handler;
    },
  } as unknown as McpServer;

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(capturedHandler, 'handler was captured');

  await capturedHandler(
    {
      message: 'test',
      path: '/some/path',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );
});

test('defineTool: progressMessage is forwarded to registerStandardTool', (): void => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
    progressMessage: (args) => `Processing: ${args.message}`,
  });

  const mockServer = {
    registerTool: (
      _name: string,
      _schema: unknown,
      _handler: unknown
    ): void => {
      // Verify option is accepted
    },
  } as unknown as McpServer;

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });
});

test('defineTool: completionMessage is forwarded to registerStandardTool', (): void => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
    completionMessage: (args, result) =>
      result.isError ? 'Failed' : `Done: ${args.message}`,
  });

  const mockServer = {
    registerTool: (
      _name: string,
      _schema: unknown,
      _handler: unknown
    ): void => {
      // Verify option is accepted
    },
  } as unknown as McpServer;

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });
});

test('defineTool: handler returns not-initialized error when guard fails', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => false,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  const result = await captured.handler(
    {
      message: 'test',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.ok(result.isError, 'result is an error when not initialized');
  assert.equal(result.errorCode, ErrorCode.INVALID_INPUT);
});

test('defineTool: handler validates input schema and returns INVALID_INPUT on failure', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => buildToolResponse('test', { ok: true, result: 'success' }),
  });

  let capturedHandler:
    | ((
        args: unknown,
        ctx: Record<string, unknown>
      ) => Promise<ToolResult<TestOutput>>)
    | undefined;
  const mockServer = {
    registerTool: (
      _name: string,
      _schema: unknown,
      handler: (
        args: unknown,
        ctx: Record<string, unknown>
      ) => Promise<ToolResult<TestOutput>>
    ): void => {
      capturedHandler = handler;
    },
  } as unknown as McpServer;

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(capturedHandler, 'handler was captured');

  const result = await capturedHandler(
    {
      message: 123,
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.ok(result.isError, 'result is an error');
  assert.equal(result.errorCode, ErrorCode.INVALID_INPUT);
});

test('defineTool: handler validates output schema', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => {
      return buildToolResponse('test', {
        ok: true,
        result: 123 as unknown as string,
      });
    },
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  const result = await captured.handler(
    {
      message: 'test',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.ok(result.isError, 'result is an error when output validation fails');
});

test('defineTool: handler returns formatted error on thrown exception', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => {
      throw new Error('Test error message');
    },
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  const result = await captured.handler(
    {
      message: 'test',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.ok(result.isError, 'result is an error');
  assert.equal(result.errorCode, ErrorCode.UNKNOWN);
});

test('defineTool: defaultErrorCode is used in error responses', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async () => {
      throw new Error('Test error');
    },
    defaultErrorCode: ErrorCode.TIMEOUT,
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  const result = await captured.handler(
    {
      message: 'test',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.ok(result.isError);
  assert.equal(result.errorCode, ErrorCode.TIMEOUT);
});

test('defineTool: resourceStore is injected into ToolRunContext', async (): Promise<void> => {
  let capturedResourceStore: unknown;

  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async (_args, ctx) => {
      capturedResourceStore = ctx.resourceStore;
      return buildToolResponse('test', { ok: true, result: 'success' });
    },
  });

  const captured: CapturedHandler = { handler: undefined };
  const mockServer = createMockServer(captured);

  const mockResourceStore = { mock: true };
  tool.register(mockServer, {
    pathGuard: null as unknown as PathGuard,
    resourceStore: mockResourceStore as unknown as ResourceStore,
    isInitialized: () => true,
    hasTaskSupport: false,
  });

  assert.ok(captured.handler, 'handler was captured');

  await captured.handler(
    {
      message: 'test',
    },
    {
      log: undefined,
      signal: new AbortController().signal,
      _meta: {},
    }
  );

  assert.equal(capturedResourceStore, mockResourceStore);
});

test('defineTool: handle is callable directly without MCP server setup', async (): Promise<void> => {
  const tool = defineTool<TestInput, TestOutput>({
    contract: TEST_CONTRACT,
    run: async (args, ctx) => {
      assert.ok(ctx.signal === undefined || ctx.signal instanceof AbortSignal);
      assert.ok(ctx.resourceStore === undefined);
      return buildToolResponse(`Got: ${args.message}`, {
        ok: true,
        result: args.message.toUpperCase(),
      });
    },
  });

  // Call handle directly without any MCP machinery
  const result = await tool.handle(
    { message: 'hello' },
    { pathGuard: null as unknown as PathGuard, resourceStore: undefined }
  );

  assert.ok(!result.isError, 'result should not be an error');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.result, 'HELLO');
});
