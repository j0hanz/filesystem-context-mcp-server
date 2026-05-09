import { InMemoryTaskStore, type Result, type Task } from '@modelcontextprotocol/server';

import { CANCELLED_RESULT_TTL_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';

const DEFAULT_CANCELLED_STATUS_MESSAGE = 'Client cancelled task execution.';

/**
 * Gate O(n) eviction scan behind this threshold. Only scan when stored results exceed this count.
 * Prevents performance regression from repeated linear scans during steady-state operation.
 */
const EVICTION_SIZE_THRESHOLD = 100;

interface TimestampedResult {
  result: Result;
  createdAt: number;
}

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
  private readonly cancelledResults = new Map<string, TimestampedResult>();

  private evictExpired(): void {
    // Gate O(n) eviction scan behind threshold to prevent performance regression
    if (this.cancelledResults.size <= EVICTION_SIZE_THRESHOLD) {
      return;
    }

    const now = Date.now();
    for (const [key, entry] of this.cancelledResults) {
      if (now - entry.createdAt > CANCELLED_RESULT_TTL_MS) {
        this.cancelledResults.delete(key);
      }
    }
  }

  override async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    this.evictExpired();
    try {
      return await super.getTaskResult(taskId, sessionId);
    } catch (error) {
      const task = await super.getTask(taskId, sessionId);
      if (task?.status !== 'cancelled') {
        throw error;
      }

      const key = getTaskKey(taskId, sessionId);
      const existing = this.cancelledResults.get(key);
      if (existing) return existing.result;

      const result = buildCancelledTaskResult(task.statusMessage);
      this.cancelledResults.set(key, { result, createdAt: Date.now() });
      return result;
    }
  }

  override async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string,
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

      const key = getTaskKey(taskId, sessionId);
      const existing = this.cancelledResults.get(key);
      const now = Date.now();
      this.cancelledResults.set(key, {
        result: existing?.result ?? result,
        createdAt: existing?.createdAt ?? now,
      });
    }
  }

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    const key = getTaskKey(taskId, sessionId);
    if (status === 'cancelled') {
      const existing = this.cancelledResults.get(key);
      this.cancelledResults.set(key, {
        result: existing?.result ?? buildCancelledTaskResult(statusMessage),
        createdAt: existing?.createdAt ?? Date.now(),
      });
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
