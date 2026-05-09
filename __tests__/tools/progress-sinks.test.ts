import type {
  ProgressNotification,
  RequestTaskStore,
} from '@modelcontextprotocol/server';

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ProgressSession } from '../../src/lib/progress-session.js';
import {
  McpProgressSink,
  progressSessionFromContext,
  TaskStoreSink,
} from '../../src/tools/progress-sinks.js';
import type { ToolContext } from '../../src/tools/shared.js';

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

interface FakeUpdateCall {
  taskId: string;
  status: string;
  message: string;
}

class FakeTaskStore {
  readonly calls: FakeUpdateCall[] = [];
  shouldReject?: Error;
  async updateTaskStatus(
    taskId: string,
    status: 'working' | 'completed' | 'failed',
    message: string
  ): Promise<void> {
    if (this.shouldReject) throw this.shouldReject;
    this.calls.push({ taskId, status, message });
  }
}

void describe('TaskStoreSink', () => {
  void it('writes "working" status for tick events with current/total formatting', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({
      taskStore: store as unknown as RequestTaskStore,
      taskId: 't-1',
    });

    await sink.emit({
      kind: 'tick',
      current: 3,
      total: 10,
      message: 'scanning',
    });

    assert.equal(store.calls.length, 1);
    assert.deepEqual(store.calls[0], {
      taskId: 't-1',
      status: 'working',
      message: 'scanning (3/10)',
    });
  });

  void it('uses raw message for status events', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({
      taskStore: store as unknown as RequestTaskStore,
      taskId: 't-1',
    });

    await sink.emit({ kind: 'status', message: 'still scanning subtree X' });

    assert.deepEqual(store.calls[0]?.message, 'still scanning subtree X');
  });

  void it('writes complete and fail events as working updates', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({
      taskStore: store as unknown as RequestTaskStore,
      taskId: 't-1',
    });

    await sink.emit({
      kind: 'complete',
      current: 5,
      total: 5,
      message: 'all done',
    });
    await sink.emit({
      kind: 'fail',
      current: 2,
      total: 5,
      message: 'aborted',
      error: new Error('x'),
    });

    assert.equal(store.calls.length, 2);
    assert.equal(store.calls[0]?.status, 'working');
    assert.equal(store.calls[0]?.message, 'all done (5/5)');
    assert.equal(store.calls[1]?.message, 'aborted (2/5)');
  });

  void it('swallows benign "Task not found" errors', async () => {
    const store = new FakeTaskStore();
    store.shouldReject = new Error('Task t-1 not found');
    const sink = new TaskStoreSink({
      taskStore: store as unknown as RequestTaskStore,
      taskId: 't-1',
    });

    // Must not throw.
    await sink.emit({
      kind: 'tick',
      current: 1,
      total: 1,
      message: 'm',
    });
  });

  void it('swallows benign "terminal status" errors', async () => {
    const store = new FakeTaskStore();
    store.shouldReject = new Error('Cannot update terminal status');
    const sink = new TaskStoreSink({
      taskStore: store as unknown as RequestTaskStore,
      taskId: 't-1',
    });

    await sink.emit({
      kind: 'tick',
      current: 1,
      total: 1,
      message: 'm',
    });
  });

  void it('rethrows non-benign errors so emitGuarded can log them', async () => {
    const store = new FakeTaskStore();
    store.shouldReject = new Error('database offline');
    const sink = new TaskStoreSink({
      taskStore: store as unknown as RequestTaskStore,
      taskId: 't-1',
    });

    await assert.rejects(
      () =>
        Promise.resolve(
          sink.emit({
            kind: 'tick',
            current: 1,
            total: 1,
            message: 'm',
          })
        ),
      /database offline/
    );
  });
});

void describe('progressSessionFromContext', () => {
  void it('constructs a session with McpProgressSink if _meta.progressToken is present', async () => {
    let notified = false;
    const ctx = {
      _meta: { progressToken: 'tok-1' },
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

  void it('constructs a session with TaskStoreSink if taskId and taskStore are present', async () => {
    const store = new FakeTaskStore();
    const ctx = {
      taskId: 't-1',
      taskStore: store,
    } as unknown as ToolContext;

    const session = progressSessionFromContext(ctx, { label: 'test' });
    assert.ok(session instanceof ProgressSession);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0]?.taskId, 't-1');
  });

  void it('constructs a session with both sinks if both sets of metadata are present', async () => {
    let notified = false;
    const store = new FakeTaskStore();
    const ctx = {
      _meta: { progressToken: 'tok-1' },
      sendNotification: async () => {
        notified = true;
      },
      taskId: 't-1',
      taskStore: store,
    } as unknown as ToolContext;

    const session = progressSessionFromContext(ctx, { label: 'test' });
    assert.ok(session instanceof ProgressSession);

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(notified);
    assert.equal(store.calls.length, 1);
  });

  void it('constructs a session with no sinks if metadata is missing', async () => {
    const ctx = {} as ToolContext;
    const session = progressSessionFromContext(ctx, { label: 'test' });
    assert.ok(session instanceof ProgressSession);
    // Should just not do anything but still be a valid session.
  });
});
