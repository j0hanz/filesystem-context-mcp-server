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
        notifications.push(n as ProgressNotification);
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
        notifications.push(n as ProgressNotification);
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
        notifications.push(n as ProgressNotification);
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
        notifications.push(n as ProgressNotification);
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
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

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
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    await sink.emit({ kind: 'status', message: 'still scanning subtree X' });

    assert.deepEqual(store.calls[0]?.message, 'still scanning subtree X');
  });

  void it('writes complete and fail events as working updates', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

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
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

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
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

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
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

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
