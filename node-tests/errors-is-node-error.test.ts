import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isNodeError } from '../src/lib/errors.js';

test('isNodeError returns true for Node.js ErrnoException', () => {
  const error = Object.assign(new Error('test'), { code: 'ENOENT' });
  assert.equal(isNodeError(error), true);
});

test('isNodeError returns false for Error without code', () => {
  const error = new Error('test');
  assert.equal(isNodeError(error), false);
});

test('isNodeError returns false for non-Error objects', () => {
  assert.equal(isNodeError('string'), false);
  assert.equal(isNodeError({ code: 'ENOENT' }), false);
  assert.equal(isNodeError(null), false);
  assert.equal(isNodeError(undefined), false);
});

test('isNodeError returns false for Error with non-string code', () => {
  const error = Object.assign(new Error('test'), { code: 123 });
  assert.equal(isNodeError(error), false);
});
