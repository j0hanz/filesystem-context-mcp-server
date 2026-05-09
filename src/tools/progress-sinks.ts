import type { ProgressNotification, ProgressToken } from '@modelcontextprotocol/server';

import { classifyError } from '../core/errors.js';
import { Logger, ProgressSession } from '../core/observability.js';
import type { ProgressEvent, ProgressSink } from '../core/observability.js';
import type { ToolContext } from './shared.js';

export { ProgressSession };

interface McpProgressSinkOptions {
  progressToken: ProgressToken;
  sendNotification: (n: ProgressNotification) => Promise<void>;
  signal: AbortSignal;
  log?: ToolContext['log'];
}

export class McpProgressSink implements ProgressSink {
  readonly name = 'mcp';
  readonly #progressToken: ProgressToken;
  readonly #sendNotification: (n: ProgressNotification) => Promise<void>;
  readonly #signal: AbortSignal;
  readonly #log?: ToolContext['log'];

  constructor(opts: McpProgressSinkOptions) {
    this.#progressToken = opts.progressToken;
    this.#sendNotification = opts.sendNotification;
    this.#signal = opts.signal;
    this.#log = opts.log;
  }

  async emit(event: ProgressEvent): Promise<void> {
    if (this.#signal.aborted) return;

    if (event.kind === 'status') {
      await this.#log?.('info', `Progress Status: ${event.message}`);
      return;
    }

    if (event.kind === 'tick') {
      await this.#send({
        progress: event.current,
        ...(event.total !== undefined ? { total: event.total } : {}),
        message: event.message,
      });
      return;
    }

    // complete | fail — normalize to 100% display.
    const displayCurrent = Math.max(event.current, event.total ?? event.current, 1);
    await this.#send({
      progress: displayCurrent,
      total: displayCurrent,
      message: event.message,
    });
  }

  async #send(params: { progress: number; total?: number; message?: string }): Promise<void> {
    await this.#sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken: this.#progressToken,
        ...params,
      },
    } satisfies ProgressNotification);
  }
}

function hasMcpProgress(ctx: ToolContext): ctx is ToolContext & {
  _meta: { progressToken: ProgressToken };
  sendNotification: NonNullable<ToolContext['sendNotification']>;
  signal: AbortSignal;
} {
  return Boolean(ctx._meta?.progressToken && ctx.sendNotification && ctx.signal);
}

export function progressSessionFromContext(
  ctx: ToolContext,
  opts: { label: string; total?: number },
): ProgressSession {
  const sinks: ProgressSink[] = [];

  if (hasMcpProgress(ctx)) {
    try {
      sinks.push(
        new McpProgressSink({
          progressToken: ctx._meta.progressToken,
          sendNotification: ctx.sendNotification,
          signal: ctx.signal,
          log: ctx.log,
        }),
      );
    } catch (error) {
      Logger.warn(
        'progress-sinks',
        `Failed to instantiate McpProgressSink: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return new ProgressSession({
    label: opts.label,
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    sinks,
    dynamicRateLimit: true,
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
  params: BatchParams,
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
  body: () => Promise<{ value: T; suffix: string; finalCurrent?: number }>,
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
  body: (progress: ProgressSession) => Promise<{ value: T; suffix: string; finalCurrent?: number }>,
  initialTotal?: number,
): Promise<T> {
  const progress = progressSessionFromContext(ctx, {
    label,
    ...(initialTotal !== undefined ? { total: initialTotal } : {}),
  });
  return completeProgressSession(progress, label, () => body(progress));
}
