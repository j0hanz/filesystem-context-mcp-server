import type { ProgressNotification } from '@modelcontextprotocol/server';

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ProgressSession } from '../../src/core/observability.js';
import { McpProgressSink, progressSessionFromContext } from '../../src/tools/_helpers.js';
import type { ToolContext } from '../../src/tools/_helpers.js';

void describe('McpProgressSink', () => {
  void it('forwards tick events to sendNotification', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      signal: new AbortController().signal,
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n);
      },
    });

    await sink.emit({
      kind: 'tick',
      current: 3,
      total: 10,
      message: 'three',
    });

    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], {
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        progress: 3,
        total: 10,
        message: 'three',
      },
    });
  });

  void it('ignores status events', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      signal: new AbortController().signal,
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n);
      },
    });

    await sink.emit({ kind: 'status', message: 'scanning' });

    assert.equal(notifications.length, 0);
  });

  void it('normalizes complete events to 100% display', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      signal: new AbortController().signal,
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n);
      },
    });

    // current=2, total=5 → display as 5/5 (legacy "show 100%" quirk).
    await sink.emit({
      kind: 'complete',
      current: 2,
      total: 5,
      message: 'done',
    });

    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0]?.params, {
      progressToken: 'tok-1',
      progress: 5,
      total: 5,
      message: 'done',
    });
  });

  void it('normalizes fail events to display max(current, total, 1)', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      signal: new AbortController().signal,
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n);
      },
    });

    // No total, current=0 → display 1/1.
    await sink.emit({
      kind: 'fail',
      current: 0,
      message: 'aborted',
      error: new Error('x'),
    });

    assert.deepEqual(notifications[0]?.params, {
      progressToken: 'tok-1',
      progress: 1,
      total: 1,
      message: 'aborted',
    });
  });
});

void describe('progressSessionFromContext', () => {
  void it('constructs a session with McpProgressSink if _meta.progressToken is present', async () => {
    let notified = false;
    const ctx = {
      _meta: { progressToken: 'tok-1' },
      signal: new AbortController().signal,
      sendNotification: async () => {
        notified = true;
      },
    } as unknown as ToolContext;

    const session = progressSessionFromContext(ctx, { label: 'test' });
    assert.ok(session instanceof ProgressSession);

    // The constructor emits a start tick asynchronously.
    // We wait a bit to let the microtask queue clear.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(notified, 'McpProgressSink should have sent a notification');
  });

  void it('constructs a session with no sinks if metadata is missing', async () => {
    const ctx = {} as ToolContext;
    const session = progressSessionFromContext(ctx, { label: 'test' });
    assert.ok(session instanceof ProgressSession);
    // Should just not do anything but still be a valid session.
  });
});
