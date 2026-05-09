import { strict as assert } from 'node:assert';

import { describe, it } from 'node:test';

import {
  type ProgressEvent,
  ProgressSession,
  type ProgressSink,
} from '../../src/lib/progress-session.js';

class MemorySink implements ProgressSink {
  readonly name = 'memory';
  readonly events: ProgressEvent[] = [];
  emit(event: ProgressEvent): void {
    this.events.push(event);
  }
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

void describe('ProgressSession', () => {
  void it('emits a synthetic start tick on construction', () => {
    const sink = new MemorySink();
    new ProgressSession({
      label: 'Hash: foo.bin',
      total: 10,
      sinks: [sink],
      now: makeClock().now,
    });
    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'tick',
      current: 0,
      total: 10,
      message: 'Hash: foo.bin',
    });
  });

  void it('step advances cursor by one and emits a tick', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      total: 3,
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    clock.advance(100);
    session.step('one');
    clock.advance(100);
    session.step('two');

    assert.equal(session.current, 2);
    assert.equal(sink.events.length, 2);
    assert.deepEqual(sink.events[0], {
      kind: 'tick',
      current: 1,
      total: 3,
      message: 'one',
    });
    assert.deepEqual(sink.events[1], {
      kind: 'tick',
      current: 2,
      total: 3,
      message: 'two',
    });
  });

  void it('set clamps cursor monotonically and emits with provided fields', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    clock.advance(100);
    session.set({ current: 5, total: 10, message: 'five' });
    clock.advance(100);
    // Regress attempt: should clamp to existing cursor (5).
    session.set({ current: 2, message: 'should clamp' });

    assert.equal(session.current, 5);
    assert.equal(sink.events.length, 2);
    assert.deepEqual(sink.events[0], {
      kind: 'tick',
      current: 5,
      total: 10,
      message: 'five',
    });
    assert.deepEqual(sink.events[1], {
      kind: 'tick',
      current: 5,
      message: 'should clamp',
    });
  });

  void it('complete sets #done and emits terminal complete event', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      total: 10,
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    session.complete('finished');

    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'complete',
      current: 0,
      total: 10,
      message: 'finished',
    });

    // Subsequent calls are no-ops
    session.step('too late');
    assert.equal(sink.events.length, 1);
  });

  void it('fail sets #done and emits terminal fail event', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      total: 10,
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    const error = new Error('boom');
    session.fail(error, 'failed');

    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'fail',
      current: 0,
      total: 10,
      message: 'failed',
      error,
    });

    // Subsequent calls are no-ops
    session.complete('ignored');
    assert.equal(sink.events.length, 1);
  });
});
