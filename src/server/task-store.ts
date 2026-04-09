import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Result } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode } from '../lib/errors.js';

const DEFAULT_CANCELLED_STATUS_MESSAGE = 'Client cancelled task execution.';

function getTaskKey(taskId: string, sessionId?: string): string {
  return `${sessionId ?? ''}:${taskId}`;
}

function buildCancelledTaskResult(statusMessage?: string): Result {
  return {
    content: [
      {
        type: 'text',
        text: `Error [${ErrorCode.CANCELLED}]: ${statusMessage ?? DEFAULT_CANCELLED_STATUS_MESSAGE}`,
      },
    ],
    isError: true,
    errorCode: ErrorCode.CANCELLED,
  };
}

export class ResultAwareInMemoryTaskStore extends InMemoryTaskStore {
  private readonly cancelledResults = new Map<string, Result>();

  override async getTaskResult(
    taskId: string,
    sessionId?: string
  ): Promise<Result> {
    try {
      return await super.getTaskResult(taskId, sessionId);
    } catch (error) {
      const task = await super.getTask(taskId, sessionId);
      if (task?.status !== 'cancelled') {
        throw error;
      }

      const key = getTaskKey(taskId, sessionId);
      const existing = this.cancelledResults.get(key);
      if (existing) return existing;

      const result = buildCancelledTaskResult(task.statusMessage);
      this.cancelledResults.set(key, result);
      return result;
    }
  }

  override async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string
  ): Promise<void> {
    try {
      await super.storeTaskResult(taskId, status, result, sessionId);
      if (status !== 'failed') {
        this.cancelledResults.delete(getTaskKey(taskId, sessionId));
      }
    } catch (error) {
      const task = await super.getTask(taskId, sessionId);
      if (task?.status !== 'cancelled') {
        throw error;
      }

      this.cancelledResults.set(
        getTaskKey(taskId, sessionId),
        this.cancelledResults.get(getTaskKey(taskId, sessionId)) ?? result
      );
    }
  }

  override async updateTaskStatus(
    taskId: string,
    status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled',
    statusMessage?: string,
    sessionId?: string
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    const key = getTaskKey(taskId, sessionId);
    if (status === 'cancelled') {
      this.cancelledResults.set(
        key,
        this.cancelledResults.get(key) ??
          buildCancelledTaskResult(statusMessage)
      );
      return;
    }

    if (status === 'completed' || status === 'failed') {
      this.cancelledResults.delete(key);
    }
  }

  override cleanup(): void {
    this.cancelledResults.clear();
    super.cleanup();
  }
}

export function createTaskStore(): ResultAwareInMemoryTaskStore {
  return new ResultAwareInMemoryTaskStore();
}
