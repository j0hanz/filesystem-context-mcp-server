import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { assignDefined, debounce, parseEnvInt } from '../../src/core/util.js';

describe('util.ts utilities', () => {
  describe('assignDefined', () => {
    it('assigns defined properties, ignoring undefined ones', () => {
      const target = { a: 1, b: 2 };
      const source = { a: 3, b: undefined, c: 4 };
      const result = assignDefined(target, source as unknown as Partial<typeof target>);
      assert.deepEqual(result, { a: 3, b: 2, c: 4 });
    });

    it('assigns Symbol keys', () => {
      const sym = Symbol('test');
      const target = { a: 1 };
      const source = { [sym]: 'symbol-val', b: undefined };
      const result = assignDefined(target, source as unknown as Partial<typeof target>);
      assert.equal((result as Record<PropertyKey, unknown>)[sym], 'symbol-val');
    });

    it('does not crash when assigning to frozen/sealed targets', () => {
      const target = Object.freeze({ a: 1 });
      const source = { a: 2 };
      // Should not throw
      const result = assignDefined(target, source);
      assert.equal(result.a, 1); // target remains frozen
    });
  });

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
