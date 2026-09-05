import type { Notification } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { McpProgressSink, ProgressSession } from '../src/tools/progress.js';

interface Frame {
  progress: number;
  total?: number;
  message?: string;
}

function collector(): { sent: Frame[]; notify: (n: Notification) => Promise<void> } {
  const sent: Frame[] = [];
  return {
    sent,
    notify: (n) => {
      sent.push(n.params as unknown as Frame);
      return Promise.resolve();
    },
  };
}

/**
 * Mirrors how ToolExecutor builds its session (src/tools/define.ts): no `total`,
 * rate limiting off. A session that knows no total reports the cursor on its
 * terminal frame, which is the value the last tick already used — the case the
 * sink's monotonic guard has to handle without swallowing the outcome.
 */
function session(sink: McpProgressSink): ProgressSession {
  return new ProgressSession({ label: 'label', sink, rateLimitMs: 0 });
}

describe('McpProgressSink wire monotonicity', () => {
  it('delivers every frame of a totalless session, strictly increasing', async () => {
    const { sent, notify } = collector();
    const sink = new McpProgressSink('t', 'tok', notify);
    const progress = session(sink);

    progress.set({ current: 1 });
    progress.set({ current: 2 });
    progress.complete('done');
    await sink.flush();

    // 0 is the session's synthetic start tick; 3 is the completion advanced past
    // the cursor it would otherwise have repeated.
    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1, 2, 3],
    );
    assert.strictEqual(sent.at(-1)?.message, 'done');
  });

  it('delivers the fail frame and its message', async () => {
    const { sent, notify } = collector();
    const sink = new McpProgressSink('t', 'tok', notify);
    const progress = session(sink);

    progress.set({ current: 1 });
    progress.fail(new Error('boom'), 'failed');
    await sink.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [0, 1, 2],
    );
    assert.strictEqual(sent.at(-1)?.message, 'failed');
  });

  it('keeps a known total ahead of the advanced completion', async () => {
    const { sent, notify } = collector();
    const sink = new McpProgressSink('t', 'tok', notify);

    sink.emit({ kind: 'tick', current: 1, total: 2, message: 'a' });
    sink.emit({ kind: 'tick', current: 2, total: 2, message: 'b' });
    sink.emit({ kind: 'complete', current: 2, total: 2, message: 'done' });
    await sink.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [1, 2, 3],
    );
    assert.strictEqual(sent.at(-1)?.total, 3);
  });

  it('drops a tick that repeats the last value on the wire', async () => {
    const { sent, notify } = collector();
    const sink = new McpProgressSink('t', 'tok', notify);

    sink.emit({ kind: 'tick', current: 1, total: 3, message: 'a' });
    sink.emit({ kind: 'tick', current: 1, total: 3, message: 'again' });
    await sink.flush();

    assert.deepStrictEqual(
      sent.map((f) => f.progress),
      [1],
    );
  });
});
