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

  void it('status emits a status event without advancing cursor', () => {
    const sink = new MemorySink();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
    });
    sink.events.length = 0;

    session.status('connecting...');

    assert.equal(session.current, 0);
    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'status',
      message: 'connecting...',
    });
  });

  void it('rate-limits tick events but bypasses for terminal and status events', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'rate-limit',
      sinks: [sink],
      now: clock.now,
      rateLimitMs: 50,
    });
    // Synthetic start at t=1000.
    assert.equal(sink.events.length, 1);
    sink.events.length = 0;

    // t=1010 (within 50ms)
    clock.advance(10);
    session.step('skip this');
    assert.equal(sink.events.length, 0);
    assert.equal(session.current, 1);

    // t=1020 (within 50ms) — status bypasses rate limit
    clock.advance(10);
    session.status('bypass-status');
    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0]?.kind, 'status');
    assert.equal(session.current, 1);
    sink.events.length = 0;

    // t=1060 (past 50ms window since start at 1000)
    clock.advance(40);
    session.step('keep this');
    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0]?.kind, 'tick');
    assert.equal(sink.events[0]?.message, 'keep this');
    assert.equal(session.current, 2);
    sink.events.length = 0;

    // t=1070 (within 50ms of 1060)
    clock.advance(10);
    session.step('skip this too');
    assert.equal(sink.events.length, 0);
    assert.equal(session.current, 3);

    // t=1080 (within 50ms) — terminal complete bypasses
    clock.advance(10);
    session.complete('done');
    assert.equal(sink.events.length, 1);
    assert.equal(sink.events[0]?.kind, 'complete');
    assert.equal(session.current, 3);
  });
});
