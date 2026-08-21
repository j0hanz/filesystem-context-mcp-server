import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import {
  type ProgressEvent,
  ProgressSession,
  type ProgressSink,
} from '../../src/tools/progress.js';

class MemorySink implements ProgressSink {
  readonly name = 'memory';
  readonly events: ProgressEvent[] = [];
  emit(event: ProgressEvent): void {
    this.events.push(event);
  }
}

/**
 * The rate limiter reads Date.now directly, so the clock is faked at the
 * runtime level rather than injected through a constructor seam.
 */
function makeClock(): { advance: (ms: number) => void } {
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  return { advance: (ms) => mock.timers.tick(ms) };
}

function tickOf(
  events: ProgressEvent[],
  index: number,
): { current: number; total?: number; message: string } {
  const ev = events[index];
  assert.ok(ev?.kind === 'tick', `expected tick at ${index}`);
  return {
    current: ev.current,
    ...(ev.total !== undefined ? { total: ev.total } : {}),
    message: ev.message,
  };
}

void describe('ProgressSession', () => {
  beforeEach(() => {
    mock.timers.reset();
  });

  void it('emits a synthetic start tick on construction', () => {
    const sink = new MemorySink();
    makeClock();
    new ProgressSession({
      label: 'Hash: foo.bin',
      total: 10,
      sinks: [sink],
    });
    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'tick',
      current: 0,
      total: 10,
      message: 'Hash: foo.bin',
    });
  });

  void it('set advances the cursor monotonically and emits a tick per call', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      total: 3,
      sinks: [sink],
    });
    sink.events.length = 0;

    clock.advance(100);
    session.set({ current: 1, message: 'one' });
    clock.advance(100);
    session.set({ current: 2, message: 'two' });

    assert.equal(sink.events.length, 2);
    assert.deepEqual(tickOf(sink.events, 0), { current: 1, total: 3, message: 'one' });
    assert.deepEqual(tickOf(sink.events, 1), { current: 2, total: 3, message: 'two' });
  });

  void it('set drops backward or duplicate ticks (cursor is clamped monotonically)', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
    });
    sink.events.length = 0;

    clock.advance(100);
    session.set({ current: 5, total: 10, message: 'five' });
    clock.advance(100);
    // Backward tick: spec requires strictly advancing, this is dropped.
    session.set({ current: 2, message: 'should drop' });

    assert.equal(sink.events.length, 1);
    assert.deepEqual(tickOf(sink.events, 0), { current: 5, total: 10, message: 'five' });
  });

  void it('complete emits a complete event carrying the current cursor', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      total: 5,
      sinks: [sink],
    });
    sink.events.length = 0;
    clock.advance(100);
    session.set({ current: 2, message: 'two' });
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
    });
    session.complete('done');
    sink.events.length = 0;

    session.set({ current: 99, message: 'ignored' });
    session.complete('again');
    session.fail(new Error('again'));

    assert.equal(sink.events.length, 0);
  });

  void it('rate-limits tick events within 50ms window', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
    });
    sink.events.length = 0;

    clock.advance(100);
    session.set({ current: 1, message: 'a' }); // emitted

    clock.advance(10);
    session.set({ current: 2, message: 'b' }); // suppressed (within 50ms)

    clock.advance(10);
    session.set({ current: 3, message: 'c' }); // suppressed

    clock.advance(50);
    session.set({ current: 4, message: 'd' }); // emitted (60ms since last sent)

    assert.equal(sink.events.length, 2);
    assert.equal(tickOf(sink.events, 0).message, 'a');
    assert.equal(tickOf(sink.events, 1).message, 'd');
  });

  void it('terminal events bypass the rate limit', () => {
    const sink = new MemorySink();
    const clock = makeClock();
    const session = new ProgressSession({
      label: 'job',
      sinks: [sink],
    });
    sink.events.length = 0;

    clock.advance(100);
    session.set({ current: 1, message: 'a' }); // emitted, marks lastSentMs

    clock.advance(5);
    session.complete('done'); // must emit despite being within 50ms

    assert.equal(sink.events.length, 2);
    assert.equal(sink.events[1]?.kind, 'complete');
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
    });
    session.set({ current: 3, message: 'three' });
    session.complete('done');
    // No sinks — nothing to assert beyond "no throw".
    assert.ok(session);
  });
});
