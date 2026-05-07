// __tests__/unit/observability-metrics.test.ts (new file)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  onMetricsUpdate,
  withToolDiagnostics,
} from '../../src/lib/observability.js';

describe('onMetricsUpdate', () => {
  it('calls registered listeners after a tool run completes', async () => {
    let callCount = 0;
    const unsubscribe = onMetricsUpdate(() => {
      callCount++;
    });
    try {
      await withToolDiagnostics('test-tool-obs', async () => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true },
      }));
      assert.equal(
        callCount,
        1,
        'listener must be called exactly once per tool run'
      );
    } finally {
      unsubscribe();
    }
  });

  it('does not call unsubscribed listeners', async () => {
    let callCount = 0;
    const unsubscribe = onMetricsUpdate(() => {
      callCount++;
    });
    unsubscribe();
    await withToolDiagnostics('test-tool-obs2', async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    }));
    assert.equal(callCount, 0, 'unsubscribed listener must not be called');
  });
});
