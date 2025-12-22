import { expect, it } from 'vitest';

import { isNodeError } from '../../lib/errors.js';

it('isNodeError returns true for Node.js ErrnoException', () => {
  const error = Object.assign(new Error('test'), { code: 'ENOENT' });
  expect(isNodeError(error)).toBe(true);
});

it('isNodeError returns false for Error without code', () => {
  const error = new Error('test');
  expect(isNodeError(error)).toBe(false);
});

it('isNodeError returns false for non-Error objects', () => {
  expect(isNodeError('string')).toBe(false);
  expect(isNodeError({ code: 'ENOENT' })).toBe(false);
  expect(isNodeError(null)).toBe(false);
  expect(isNodeError(undefined)).toBe(false);
});

it('isNodeError returns false for Error with non-string code', () => {
  const error = Object.assign(new Error('test'), { code: 123 });
  expect(isNodeError(error)).toBe(false);
});
