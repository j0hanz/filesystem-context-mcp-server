import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLevelEnabled } from '../../src/core/observability.js';

describe('isLevelEnabled', () => {
  it('passes messages at or above the minimum severity', () => {
    for (const level of ['emergency', 'alert', 'critical', 'error', 'warning'] as const) {
      assert.equal(isLevelEnabled(level, 'warning'), true, level);
    }
  });

  it('drops messages below the minimum severity', () => {
    for (const level of ['notice', 'info', 'debug'] as const) {
      assert.equal(isLevelEnabled(level, 'warning'), false, level);
    }
  });

  it('passes everything at debug and only emergency at emergency', () => {
    assert.equal(isLevelEnabled('debug', 'debug'), true);
    assert.equal(isLevelEnabled('debug', 'emergency'), false);
    assert.equal(isLevelEnabled('emergency', 'emergency'), true);
  });

  it('defaults to info: debug suppressed, info through', () => {
    // No LOG_LEVEL is set in the test environment.
    assert.equal(isLevelEnabled('debug'), false);
    assert.equal(isLevelEnabled('info'), true);
  });
});
