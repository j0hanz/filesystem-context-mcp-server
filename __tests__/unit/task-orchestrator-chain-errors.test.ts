import { type CreateTaskServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Logger } from '../../src/core/observability.js';
import type { PathGuard } from '../../src/core/path.js';
import { TaskOrchestrator } from '../../src/tasks.js';
import { type ToolCtx, type ToolDeps } from '../../src/tools/define.js';

const stubDeps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'> = {
  pathGuard: {} as PathGuard,
  resourceStore: undefined,
};

function createMockExtra(
  store: TaskOrchestrator,
  sessionId = 'test-session',
): CreateTaskServerContext {
  let reqId = 0;
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      signal: new AbortController().signal,
      notify: async () => {},
      send: async () => ({}) as never,
      log: async () => {},
      elicitInput: async () => ({}) as never,
      requestSampling: async () => ({}) as never,
    },
    sessionId,
    task: {
      store: {
        async createTask(params: { ttl?: number }) {
          reqId++;
          return store.createTask(params, reqId, { method: 'tools/call', params: {} }, sessionId);
        },
        async getTask(taskId: string) {
          const t = await store.getTask(taskId, sessionId);
          if (!t) throw new Error(`Task with ID ${taskId} not found`);
          return t;
        },
        async updateTaskStatus(taskId: string, status, statusMessage?: string) {
          await store.updateTaskStatus(taskId, status, statusMessage, sessionId);
        },
        async storeTaskResult(taskId: string, status, result) {
          await store.storeTaskResult(taskId, status, result, sessionId);
        },
        async getTaskResult(taskId: string) {
          return store.getTaskResult(taskId, sessionId);
        },
        async listTasks(cursor?: string) {
          return store.listTasks(cursor, sessionId);
        },
      },
    },
  };
}

describe('TaskOrchestrator creationPromise chain error logging', () => {
  it('logs swallowed errors from prior task creation failures at debug level', async () => {
    const orchestrator = new TaskOrchestrator();

    try {
      const debugLogs: { message: string; data?: unknown }[] = [];
      const originalLoggerDebug = Logger.debug.bind(Logger);

      // Mock Logger.debug to capture calls
      Logger.debug = (message: string, data?: unknown) => {
        debugLogs.push({ message, data });
        originalLoggerDebug(message, data);
      };

      // Create a handler that will fail task creation twice, then succeed
      const handler = orchestrator.wrapToolTask(
        async (_args: unknown, _ctx: ToolCtx) => {
          return {
            content: [{ type: 'text', text: 'success' }],
            structuredContent: { ok: true },
          };
        },
        { toolName: 'failing_tool', deps: stubDeps },
      );

      const baseCtx = createMockExtra(orchestrator);

      // First attempt: force too many active tasks
      let createTaskCallCount = 0;
      const ctx1 = {
        ...baseCtx,
        task: {
          ...baseCtx.task,
          store: {
            ...baseCtx.task.store,
            async listTasks() {
              // Simulate too many active tasks on first call
              if (createTaskCallCount === 0) {
                return {
                  tasks: Array(100)
                    .fill(null)
                    .map((_, i) => ({
                      taskId: `active-${i}`,
                      status: 'working' as const,
                      result: undefined,
                      requestedTtl: 30000,
                      ttl: 30000,
                      pollInterval: 200,
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    })),
                  nextCursor: undefined,
                };
              }
              // Normal response for subsequent calls
              return {
                tasks: [],
                nextCursor: undefined,
              };
            },
            async createTask(params: { ttl?: number }) {
              createTaskCallCount++;
              if (createTaskCallCount === 1) {
                throw new Error('Too many active tasks (100)');
              }
              return baseCtx.task.store.createTask(params);
            },
          },
        },
      } as CreateTaskServerContext;

      // First attempt should fail internally in the promise chain
      try {
        await handler.createTask(undefined as never, ctx1);
      } catch {
        // Expected to fail at task creation
      }

      // Second attempt should work and should have logged the prior error
      const ctx2 = createMockExtra(orchestrator);
      await handler.createTask(undefined as never, ctx2);

      // Verify that the error was logged
      const chainErrorLogs = debugLogs.filter((log) =>
        log.message.includes('prior task-creation failure cleared from chain'),
      );

      assert.ok(
        chainErrorLogs.length > 0,
        'Expected at least one debug log about swallowed chain error',
      );

      const errorLog = chainErrorLogs[0];
      assert.ok(errorLog.data, 'Log data should contain error details');
      assert.strictEqual(
        (errorLog.data as Record<string, unknown>)['toolName'],
        'failing_tool',
        'Log data should include toolName',
      );
      assert.ok(
        (errorLog.data as Record<string, unknown>)['error'],
        'Log data should include error message',
      );

      // Restore original Logger.debug
      Logger.debug = originalLoggerDebug;
    } finally {
      orchestrator.cleanup();
    }
  });
});
