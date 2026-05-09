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
});
