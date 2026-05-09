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
