import { expect, it } from 'vitest';

import { classifyError, ErrorCode, McpError } from '../../lib/errors.js';

it('classifyError classifies ENOENT messages as not found', () => {
  const error = new Error('ENOENT: no such file or directory');
  expect(classifyError(error)).toBe(ErrorCode.E_NOT_FOUND);
});

it('classifyError returns unknown for unrecognized message-only errors', () => {
  const error = new Error('Some random error');
  expect(classifyError(error)).toBe(ErrorCode.E_UNKNOWN);
});

it('classifyError handles non-Error objects', () => {
  expect(classifyError('ENOENT error')).toBe(ErrorCode.E_NOT_FOUND);
  expect(classifyError({ message: 'permission denied' })).toBe(
    ErrorCode.E_UNKNOWN
  );
});

it('classifyError classifies Node.js EACCES error code', () => {
  const error = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
  });
  expect(classifyError(error)).toBe(ErrorCode.E_PERMISSION_DENIED);
});

it('classifyError classifies Node.js EPERM error code', () => {
  const error = Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
  });
  expect(classifyError(error)).toBe(ErrorCode.E_PERMISSION_DENIED);
});

it('classifyError classifies Node.js EISDIR error code', () => {
  const error = Object.assign(new Error('is a directory'), { code: 'EISDIR' });
  expect(classifyError(error)).toBe(ErrorCode.E_NOT_FILE);
});

it('classifyError classifies Node.js ENOTDIR error code', () => {
  const error = Object.assign(new Error('not a directory'), {
    code: 'ENOTDIR',
  });
  expect(classifyError(error)).toBe(ErrorCode.E_NOT_DIRECTORY);
});

it('classifyError classifies Node.js ELOOP error code', () => {
  const error = Object.assign(new Error('too many symbolic links'), {
    code: 'ELOOP',
  });
  expect(classifyError(error)).toBe(ErrorCode.E_SYMLINK_NOT_ALLOWED);
});

it('classifyError classifies Node.js ETIMEDOUT error code', () => {
  const error = Object.assign(new Error('operation timed out'), {
    code: 'ETIMEDOUT',
  });
  expect(classifyError(error)).toBe(ErrorCode.E_TIMEOUT);
});

it('classifyError classifies McpError directly by its code', () => {
  const error = new McpError(
    ErrorCode.E_TOO_LARGE,
    'File too large',
    '/path/to/file'
  );
  expect(classifyError(error)).toBe(ErrorCode.E_TOO_LARGE);
});
