import assert from 'node:assert/strict';
import { it } from 'node:test';

import { isNodeError } from '../../lib/errors.js';

void it('isNodeError returns true for Node.js ErrnoException', () => {
  const error = Object.assign(new Error('test'), { code: 'ENOENT' });
  assert.strictEqual(isNodeError(error), true);
});

void it('isNodeError returns false for Error without code', () => {
  const error = new Error('test');
  assert.strictEqual(isNodeError(error), false);
});

void it('isNodeError returns false for non-Error objects', () => {
  assert.strictEqual(isNodeError('string'), false);
  assert.strictEqual(isNodeError({ code: 'ENOENT' }), false);
  assert.strictEqual(isNodeError(null), false);
  assert.strictEqual(isNodeError(undefined), false);
});

void it('isNodeError returns false for Error with non-string code', () => {
  const error = Object.assign(new Error('test'), { code: 123 });
  assert.strictEqual(isNodeError(error), false);
});
