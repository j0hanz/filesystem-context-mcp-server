import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StopReasonTracker } from '../../src/core/search.js';

describe('StopReasonTracker', () => {
  it('resolves undefined and untruncated when nothing hit', () => {
    const tracker = new StopReasonTracker();
    assert.equal(tracker.resolve(), undefined);
    assert.equal(tracker.truncated, false);
  });

  it('maxResults wins over maxFiles and timeout', () => {
    const tracker = new StopReasonTracker();
    tracker.hitAbort();
    tracker.hitMaxFiles();
    tracker.hitMaxResults();
    assert.equal(tracker.resolve(), 'maxResults');
    assert.equal(tracker.truncated, true);
  });

  it('maxFiles wins over timeout', () => {
    const tracker = new StopReasonTracker();
    tracker.hitAbort();
    tracker.hitMaxFiles();
    assert.equal(tracker.resolve(), 'maxFiles');
    assert.equal(tracker.truncated, true);
  });

  it('timeout resolves when only abort hit', () => {
    const tracker = new StopReasonTracker();
    tracker.hitAbort();
    assert.equal(tracker.resolve(), 'timeout');
    assert.equal(tracker.truncated, true);
  });
});
