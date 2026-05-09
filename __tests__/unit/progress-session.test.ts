import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ProgressEvent,
  ProgressSession,
  type ProgressSink,
} from '../src/core/observability.js';

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

  void it('complete emits a complete event carrying the current cursor', () => {
    const sink = new MemorySink();
    const session = new ProgressSession({
      label: 'job',
      total: 5,
      sinks: [sink],
      now: makeClock().now,
    });
    session.step('a');
    session.step('b');
    sink.events.length = 0;

    session.complete('done');

    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'complete',
      current: 2,
      total: 5,
      message: 'done',
    });
  });

  void it('fail emits a fail event with error and optional message', () => {
    const sink = new MemorySink();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
      now: makeClock().now,
    });
    sink.events.length = 0;
    const err = new Error('boom');

    session.fail(err, 'aborted');

    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'fail',
      current: 0,
      message: 'aborted',
      error: err,
    });
  });

  void it('calls after a terminal event are no-ops', () => {
    const sink = new MemorySink();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
      now: makeClock().now,
    });
    session.complete('done');
    sink.events.length = 0;

    session.step('ignored');
    session.set({ current: 99, message: 'ignored' });
    session.complete('again');
    session.fail(new Error('again'));

    assert.equal(sink.events.length, 0);
    assert.equal(session.current, 0);
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

  void it('rate-limits tick events within 50ms window', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    clock.advance(100);
    session.step('a'); // emitted

    clock.advance(10);
    session.step('b'); // suppressed (within 50ms)

    clock.advance(10);
    session.step('c'); // suppressed

    clock.advance(50);
    session.step('d'); // emitted (60ms since last sent)

    assert.equal(sink.events.length, 2);
    assert.equal(sink.events[0]?.kind === 'tick' && sink.events[0].message, 'a');
    assert.equal(sink.events[1]?.kind === 'tick' && sink.events[1].message, 'd');
    // Cursor still advanced even when ticks were suppressed.
    assert.equal(session.current, 4);
  });

  void it('terminal events bypass the rate limit', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    clock.advance(100);
    session.step('a'); // emitted, marks lastSentMs

    clock.advance(5);
    session.complete('done'); // must emit despite being within 50ms

    assert.equal(sink.events.length, 2);
    assert.equal(sink.events[1]?.kind, 'complete');
  });

  void it('status events bypass the rate limit', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
      now: clock.now,
    });
    sink.events.length = 0;

    clock.advance(100);
    session.step('a'); // emitted

    clock.advance(5);
    session.status('s1'); // emitted (status not rate-limited)
    clock.advance(5);
    session.status('s2'); // emitted

    assert.equal(sink.events.length, 3);
    assert.equal(sink.events[1]?.kind, 'status');
    assert.equal(sink.events[2]?.kind, 'status');
  });

  void it('sync sink errors are caught and other sinks still receive the event', () => {
    const goodSink = new MemorySink();
    const badSink: ProgressSink = {
      name: 'bad',
      emit() {
        throw new Error('sink failure');
      },
    };
    const session = new ProgressSession({
      label: 'job',
      sinks: [badSink, goodSink],
      now: makeClock().now,
    });
    // Constructor's start tick: badSink throws but session must construct.
    assert.equal(goodSink.events.length, 1);

    // Subsequent operations also unaffected.
    session.complete('done');
    assert.equal(goodSink.events.length, 2);
  });

  void it('async sink rejections are caught', async () => {
    const goodSink = new MemorySink();
    const badSink: ProgressSink = {
      name: 'bad-async',
      emit() {
        return Promise.reject(new Error('async sink failure'));
      },
    };
    const session = new ProgressSession({
      label: 'job',
      sinks: [badSink, goodSink],
      now: makeClock().now,
    });
    session.complete('done');

    // Allow microtask queue to drain so the rejection is observed-and-swallowed.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(goodSink.events.length, 2);
  });

  void it('empty sink array works without errors', () => {
    const session = new ProgressSession({
      label: 'job',
      total: 5,
      sinks: [],
      now: makeClock().now,
    });
    session.step('a');
    session.step('b');
    session.set({ current: 3, message: 'three' });
    session.status('s');
    session.complete('done');
    assert.equal(session.current, 3);
  });
});


