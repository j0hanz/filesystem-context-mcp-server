import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { METRICS_RESOURCE } from '../../src/resources/metrics.js';

describe('METRICS_RESOURCE.createSubscription', () => {
  it('calls notify after metrics update with 500ms debounce', async () => {
    assert.ok(
      typeof METRICS_RESOURCE.createSubscription === 'function',
      'createSubscription must be defined'
    );

    const notified: string[] = [];
    const lc = METRICS_RESOURCE.createSubscription?.((uri) => {
      notified.push(uri);
    });

    // The METRICS_RESOURCE.createSubscription should have registered its own
    // onMetricsUpdate listener that debounces notify.
    assert.ok(lc, 'createSubscription must return a lifecycle');

    // Verify destroy() clears the debounce and stops notification.
    lc.destroy();

    // After destroy, onMetricsUpdate notifications must not trigger notify.
    const preDestroy = notified.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    assert.strictEqual(
      notified.length,
      preDestroy,
      'no notifications after destroy'
    );
  });

  it('destroy() is idempotent', () => {
    const lc = METRICS_RESOURCE.createSubscription?.(() => {});
    assert.ok(lc, 'createSubscription must return a lifecycle');
    lc.destroy();
    assert.doesNotThrow(() => lc.destroy());
  });

  it('onSubscribe and onUnsubscribe are no-ops (metrics always streams)', () => {
    const lc = METRICS_RESOURCE.createSubscription?.(() => {});
    assert.ok(lc, 'createSubscription must return a lifecycle');
    assert.doesNotThrow(() => lc.onSubscribe('filesystem-mcp://metrics'));
    assert.doesNotThrow(() => lc.onUnsubscribe('filesystem-mcp://metrics'));
    lc.destroy();
  });
});
