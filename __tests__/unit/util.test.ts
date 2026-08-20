import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { debounce, parseEnvInt } from '../../src/core/util.js';

describe('util.ts utilities', () => {
  describe('debounce', () => {
    it('executes callback after wait time', async () => {
      let callCount = 0;
      const fn = debounce(() => {
        callCount++;
      }, 10);
      fn();
      fn();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(callCount, 1);
    });

    it('does not crash if callback throws', async () => {
      const fn = debounce(() => {
        throw new Error('Debounce callback error');
      }, 1);
      fn();
      // Wait for execution and ensure no process crash
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(true);
    });
  });

  describe('parseEnvInt strictness', () => {
    const ORIG_TEST_VAR = process.env['TEST_STRICT_VAR'];

    afterEach(() => {
      if (ORIG_TEST_VAR === undefined) {
        delete process.env['TEST_STRICT_VAR'];
      } else {
        process.env['TEST_STRICT_VAR'] = ORIG_TEST_VAR;
      }
    });

    it('rejects strings with suffix letters', () => {
      process.env['TEST_STRICT_VAR'] = '100px';
      const result = parseEnvInt('TEST_STRICT_VAR', 50, 10, 1000);
      assert.equal(result, 50); // falls back to default
    });

    it('rejects floats', () => {
      process.env['TEST_STRICT_VAR'] = '10.5';
      const result = parseEnvInt('TEST_STRICT_VAR', 50, 10, 1000);
      assert.equal(result, 50); // falls back to default
    });

    it('accepts valid integers', () => {
      process.env['TEST_STRICT_VAR'] = '100';
      const result = parseEnvInt('TEST_STRICT_VAR', 50, 10, 1000);
      assert.equal(result, 100);
    });
  });
});
