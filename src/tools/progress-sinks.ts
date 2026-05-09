import type {
  ProgressNotification,
  ProgressToken,
} from '@modelcontextprotocol/server';

import type { ProgressEvent, ProgressSink } from '../lib/progress-session.js';

interface McpProgressSinkOptions {
  progressToken: ProgressToken;
  sendNotification: (n: ProgressNotification) => Promise<void>;
}

export class McpProgressSink implements ProgressSink {
  readonly name = 'mcp';
  readonly #progressToken: ProgressToken;
  readonly #sendNotification: (n: ProgressNotification) => Promise<void>;

  constructor(opts: McpProgressSinkOptions) {
    this.#progressToken = opts.progressToken;
    this.#sendNotification = opts.sendNotification;
  }

  async emit(event: ProgressEvent): Promise<void> {
    if (event.kind === 'status') return;

    if (event.kind === 'tick') {
      await this.#send({
        progress: event.current,
        ...(event.total !== undefined ? { total: event.total } : {}),
        message: event.message,
      });
      return;
    }

    // complete | fail — normalize to 100% display.
    const displayCurrent = Math.max(
      event.current,
      event.total ?? event.current,
      1
    );
    await this.#send({
      progress: displayCurrent,
      total: displayCurrent,
      message: event.message,
    });
  }

  async #send(params: {
    progress: number;
    total?: number;
    message?: string;
  }): Promise<void> {
    await this.#sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken: this.#progressToken,
        ...params,
      },
    } satisfies ProgressNotification);
  }
}

/**
 * Simplified task store interface for progress updates. Matches the patch
 * capability used by the TaskStoreSink.
 */
export interface TaskStore {
  updateTask(
    taskId: string,
    patch: { message?: string; statusMessage?: string }
  ): Promise<void>;
}

export interface TaskStoreSinkOptions {
  taskId: string;
  store: TaskStore;
}

/**
 * Sink that updates a TaskStore with progress information. Swallows benign
 * "Task not found" or "terminal status" errors to prevent failing the tool.
 */
export class TaskStoreSink implements ProgressSink {
  readonly name = 'task-store';
  readonly #taskId: string;
  readonly #store: TaskStore;

  constructor(opts: TaskStoreSinkOptions) {
    this.#taskId = opts.taskId;
    this.#store = opts.store;
  }

  async emit(event: ProgressEvent): Promise<void> {
    const statusMessage = event.message;

    let message = event.message;
    if (event.kind === 'tick') {
      const total = event.total;
      message =
        total !== undefined
          ? `${event.message} [${event.current}/${total}]`
          : `${event.message} [${event.current}]`;
    }

    try {
      await this.#store.updateTask(this.#taskId, {
        message,
        statusMessage,
      });
    } catch (error) {
      if (this.#isBenignError(error)) return;
      throw error;
    }
  }

  #isBenignError(error: unknown): boolean {
    return (
      error instanceof Error &&
      /Task .*not found|terminal status/iu.test(error.message)
    );
  }
}
