import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpProgressSink } from '../../src/tools/progress-sinks.js';
import type { ProgressEvent } from '../../src/lib/progress-session.js';

describe('McpProgressSink', () => {
  it('normalizes 100% on complete', () => {
    const sent: { progress: number; total: number }[] = [];
    const sink = new McpProgressSink('test-tool', (data) => {
      sent.push(data);
    });

    const event: ProgressEvent = {
      kind: 'complete',
      current: 5,
      total: 10,
      message: 'Done',
    };

    sink.emit(event);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.progress, 10);
    assert.deepEqual(sent[0]?.total, 10);
  });

  it('normalizes 100% on fail', () => {
    const sent: { progress: number; total: number }[] = [];
    const sink = new McpProgressSink('test-tool', (data) => {
      sent.push(data);
    });

    const event: ProgressEvent = {
      kind: 'fail',
      current: 3,
      total: 10,
      message: 'Failed',
      error: new Error('boom'),
    };

    sink.emit(event);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.progress, 10);
    assert.deepEqual(sent[0]?.total, 10);
  });

  it('handles missing total on complete by setting total to current', () => {
    const sent: { progress: number; total: number }[] = [];
    const sink = new McpProgressSink('test-tool', (data) => {
      sent.push(data);
    });

    const event: ProgressEvent = {
      kind: 'complete',
      current: 7,
      message: 'Done',
    };

    sink.emit(event);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.progress, 7);
    assert.deepEqual(sent[0]?.total, 7);
  });

  it('ensures at least 1/1 progress even if current/total are 0', () => {
     const sent: { progress: number; total: number }[] = [];
    const sink = new McpProgressSink('test-tool', (data) => {
      sent.push(data);
    });

    const event: ProgressEvent = {
      kind: 'complete',
      current: 0,
      total: 0,
      message: 'Done',
    };

    sink.emit(event);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.progress, 1);
    assert.deepEqual(sent[0]?.total, 1);
  });

  it('passes through tick events without 100% normalization', () => {
    const sent: { progress: number; total: number }[] = [];
    const sink = new McpProgressSink('test-tool', (data) => {
      sent.push(data);
    });

    const event: ProgressEvent = {
      kind: 'tick',
      current: 2,
      total: 10,
      message: 'Step 2',
    };

    sink.emit(event);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.progress, 2);
    assert.deepEqual(sent[0]?.total, 10);
  });
});
