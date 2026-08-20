import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { timedSignal } from '../../src/core/concurrency.js';

describe('timedSignal', () => {
  it('aborts the signal after the timeout elapses', async () => {
    const signal = timedSignal(undefined, 50);
    await sleep(100);
    assert.equal(signal.aborted, true, 'Signal must be aborted after timeout');
    assert.equal(signal.reason?.name, 'TimeoutError');
  });

  it('is not aborted before the timeout elapses', async () => {
    const signal = timedSignal(undefined, 1000);
    await sleep(20);
    assert.equal(signal.aborted, false);
  });

  it('combines base signal and timeout — base abort wins', () => {
    const ctrl = new AbortController();
    const signal = timedSignal(ctrl.signal, 1000);
    ctrl.abort(new Error('base abort'));
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as Error).message, 'base abort');
  });

  it('is already aborted when the base signal aborted first', () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('early'));
    const signal = timedSignal(ctrl.signal, 1000);
    assert.equal(signal.aborted, true);
  });

  it('still honors the deadline when the base signal never aborts', async () => {
    const ctrl = new AbortController();
    const signal = timedSignal(ctrl.signal, 50);
    await sleep(100);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason?.name, 'TimeoutError');
  });
});
