import type {
  ProgressNotification,
  ProgressToken,
  RequestTaskStore,
} from '@modelcontextprotocol/server';

import { type ProgressEvent, type ProgressSink, ProgressSession } from '../lib/progress-session.js';
import type { TaskToolContext, ToolContext } from './shared.js';

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

interface TaskStoreSinkOptions {
  taskStore: RequestTaskStore;
  taskId: string;
}

const BENIGN_TASK_ERROR_RE = /Task .*not found|terminal status/iu;

function isBenignTaskStoreError(error: unknown): boolean {
  return error instanceof Error && BENIGN_TASK_ERROR_RE.test(error.message);
}

function formatTickMessage(
  current: number,
  total: number | undefined,
  message: string | undefined
): string {
  if (total !== undefined) {
    return message ? `${message} (${current}/${total})` : `${current}/${total}`;
  }
  return message ?? `${current}`;
}

export class TaskStoreSink implements ProgressSink {
  readonly name = 'task-store';
  readonly #taskStore: RequestTaskStore;
  readonly #taskId: string;

  constructor(opts: TaskStoreSinkOptions) {
    this.#taskStore = opts.taskStore;
    this.#taskId = opts.taskId;
  }

  async emit(event: ProgressEvent): Promise<void> {
    const message =
      event.kind === 'status'
        ? event.message
        : formatTickMessage(event.current, event.total, event.message);

    try {
      await this.#taskStore.updateTaskStatus(this.#taskId, 'working', message);
    } catch (error) {
      if (isBenignTaskStoreError(error)) return;
      throw error;
    }
  }
}

function hasMcpProgress(
  ctx: ToolContext
): ctx is ToolContext & {
  _meta: { progressToken: ProgressToken };
  sendNotification: NonNullable<ToolContext['sendNotification']>;
} {
  return Boolean(ctx._meta?.progressToken && ctx.sendNotification);
}

function hasTaskProgress(
  ctx: ToolContext
): ctx is TaskToolContext & { taskId: string; taskStore: RequestTaskStore } {
  const candidate = ctx as TaskToolContext;
  return Boolean(candidate.taskId && candidate.taskStore);
}

export function progressSessionFromContext(
  ctx: ToolContext,
  opts: { label: string; total?: number }
): ProgressSession {
  const sinks: ProgressSink[] = [];

  if (hasMcpProgress(ctx)) {
    sinks.push(
      new McpProgressSink({
        progressToken: ctx._meta.progressToken,
        sendNotification: ctx.sendNotification,
      })
    );
  }

  if (hasTaskProgress(ctx)) {
    sinks.push(
      new TaskStoreSink({
        taskId: ctx.taskId,
        taskStore: ctx.taskStore,
      })
    );
  }

  return new ProgressSession({
    label: opts.label,
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    sinks,
  });
}
