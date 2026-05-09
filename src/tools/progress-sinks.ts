import type {
  ProgressNotification,
  ProgressToken,
  RequestTaskStore,
} from '@modelcontextprotocol/server';

import { classifyError } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import {
  type ProgressEvent,
  ProgressSession,
  type ProgressSink,
} from '../lib/progress-session.js';

import type { TaskToolContext, ToolContext } from './shared.js';

export { ProgressSession };

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

function hasMcpProgress(ctx: ToolContext): ctx is ToolContext & {
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
    try {
      sinks.push(
        new McpProgressSink({
          progressToken: ctx._meta.progressToken,
          sendNotification: ctx.sendNotification,
        })
      );
    } catch (error) {
      Logger.warn(
        'progress-sinks',
        `Failed to instantiate McpProgressSink: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (hasTaskProgress(ctx)) {
    try {
      sinks.push(
        new TaskStoreSink({
          taskId: ctx.taskId,
          taskStore: ctx.taskStore,
        })
      );
    } catch (error) {
      Logger.warn(
        'progress-sinks',
        `Failed to instantiate TaskStoreSink: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return new ProgressSession({
    label: opts.label,
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    sinks,
  });
}

/** Final-cursor heuristic preserved from legacy implementation. */
export function resolveFinalProgressCurrent(
  progress: ProgressSession,
  ...candidates: number[]
): number {
  let finalCurrent = progress.current + 1;
  for (const candidate of candidates) {
    if (candidate > finalCurrent) finalCurrent = candidate;
  }
  return finalCurrent;
}

interface BatchProgressCallbacks {
  progress: ProgressSession;
  onItemComplete: () => void;
}

interface BatchParams {
  toolLabel: string;
  context: string;
  totalItems: number;
  itemVerb: string;
}

export function createBatchProgressCallbacks(
  ctx: ToolContext,
  params: BatchParams
): BatchProgressCallbacks {
  const progress = progressSessionFromContext(ctx, {
    label: `${params.toolLabel}: ${params.context}`,
    total: params.totalItems,
  });

  let itemsDone = 0;
  const onItemComplete = (): void => {
    itemsDone++;
    progress.set({
      current: itemsDone,
      total: params.totalItems,
      message: `${params.toolLabel}: ${params.context} [${itemsDone}/${params.totalItems} ${params.itemVerb}]`,
    });
  };

  return { progress, onItemComplete };
}

export async function completeProgressSession<T>(
  progress: ProgressSession,
  label: string,
  body: () => Promise<{ value: T; suffix: string; finalCurrent?: number }>
): Promise<T> {
  try {
    const { value, suffix } = await body();
    progress.complete(`${label} • ${suffix}`);
    return value;
  } catch (error) {
    progress.fail(error, `${label} • ${classifyError(error)}`);
    throw error;
  }
}

export async function runWithProgressSession<T>(
  ctx: ToolContext,
  label: string,
  body: (
    progress: ProgressSession
  ) => Promise<{ value: T; suffix: string; finalCurrent?: number }>,
  initialTotal?: number
): Promise<T> {
  const progress = progressSessionFromContext(ctx, {
    label,
    ...(initialTotal !== undefined ? { total: initialTotal } : {}),
  });
  return completeProgressSession(progress, label, () => body(progress));
}
