import type { ProgressNotification } from '@modelcontextprotocol/server';

import { strict as assert } from 'node:assert';

import { describe, it } from 'node:test';

import { McpProgressSink, TaskStoreSink } from '../../src/tools/progress-sinks.js';

void describe('McpProgressSink', () => {
  void it('forwards tick events to sendNotification', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
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

void describe('TaskStoreSink', () => {
  void it('updates message and status on emit', async () => {
    let message: string | undefined;
    let statusMessage: string | undefined;

    const sink = new TaskStoreSink({
      taskId: 'task-1',
      store: {
        updateTask: async (id: string, patch: { message?: string; statusMessage?: string }) => {
          assert.equal(id, 'task-1');
          message = patch.message;
          statusMessage = patch.statusMessage;
        },
      },
    });

    await sink.emit({ kind: 'status', message: 'scanning' });
    assert.equal(message, 'scanning');
    assert.equal(statusMessage, 'scanning');

    await sink.emit({
      kind: 'tick',
      current: 5,
      total: 10,
      message: 'working',
    });
    assert.equal(message, 'working [5/10]');
    assert.equal(statusMessage, 'working');
  });

  void it('swallows "Task not found" and "terminal status" errors', async () => {
    const sink = new TaskStoreSink({
      taskId: 'task-1',
      store: {
        updateTask: async () => {
          throw new Error('Task not found');
        },
      },
    });

    // Should not throw.
    await sink.emit({ kind: 'status', message: 'x' });

    const terminalSink = new TaskStoreSink({
      taskId: 'task-1',
      store: {
        updateTask: async () => {
          throw new Error('Cannot update task with terminal status');
        },
      },
    });

    // Should not throw.
    await terminalSink.emit({ kind: 'status', message: 'y' });
  });

  void it('rethrows other errors', async () => {
    const sink = new TaskStoreSink({
      taskId: 'task-1',
      store: {
        updateTask: async () => {
          throw new Error('Database connection failed');
        },
      },
    });

    await assert.rejects(
      sink.emit({ kind: 'status', message: 'x' }),
      /Database connection failed/
    );
  });
});
