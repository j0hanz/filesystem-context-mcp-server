import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { createTimedAbortSignal } from '../../src/core/concurrency.js';

describe('createTimedAbortSignal', () => {
  it('aborts the signal after the timeout elapses', async () => {
    const { signal, cleanup } = createTimedAbortSignal(undefined, 50);
    try {
      await sleep(100);
      assert.equal(signal.aborted, true, 'Signal must be aborted after timeout');
      assert.equal(signal.reason?.name, 'TimeoutError');
    } finally {
      cleanup();
    }
  });

  it('cleanup() cancels the pending timer so the signal is NOT aborted', async () => {
    const { signal, cleanup } = createTimedAbortSignal(undefined, 100);
    cleanup(); // cancel before timeout fires
    await sleep(150); // wait longer than the timeout
    assert.equal(signal.aborted, false, 'Signal must NOT be aborted after cleanup');
  });

  it('returns a noop signal when no timeout and no base signal', () => {
    const { signal, cleanup } = createTimedAbortSignal(undefined, undefined);
    cleanup(); // no-op
    assert.equal(signal.aborted, false);
  });

  it('returns the base signal unchanged when no timeout', () => {
    const ctrl = new AbortController();
    const { signal } = createTimedAbortSignal(ctrl.signal, undefined);
    assert.equal(signal, ctrl.signal);
  });

  it('combines base signal and timeout — base abort wins', async () => {
    const ctrl = new AbortController();
    const { signal, cleanup } = createTimedAbortSignal(ctrl.signal, 1000);
    try {
      ctrl.abort();
      assert.equal(signal.aborted, true);
    } finally {
      cleanup();
    }
  });
});


