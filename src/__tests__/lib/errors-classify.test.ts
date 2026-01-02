import assert from 'node:assert/strict';
import { it } from 'node:test';

import { classifyError, ErrorCode, McpError } from '../../lib/errors.js';

void it('classifyError classifies ENOENT messages as not found', () => {
  const error = new Error('ENOENT: no such file or directory');
  assert.strictEqual(classifyError(error), ErrorCode.E_NOT_FOUND);
});

void it('classifyError returns unknown for unrecognized message-only errors', () => {
  const error = new Error('Some random error');
  assert.strictEqual(classifyError(error), ErrorCode.E_UNKNOWN);
});

void it('classifyError handles non-Error objects', () => {
  assert.strictEqual(classifyError('ENOENT error'), ErrorCode.E_NOT_FOUND);
  assert.strictEqual(
    classifyError({ message: 'permission denied' }),
    ErrorCode.E_UNKNOWN
  );
});

void it('classifyError classifies Node.js EACCES error code', () => {
  const error = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
  });
  assert.strictEqual(classifyError(error), ErrorCode.E_PERMISSION_DENIED);
});

void it('classifyError classifies Node.js EPERM error code', () => {
  const error = Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
  });
  assert.strictEqual(classifyError(error), ErrorCode.E_PERMISSION_DENIED);
});

void it('classifyError classifies Node.js EISDIR error code', () => {
  const error = Object.assign(new Error('is a directory'), { code: 'EISDIR' });
  assert.strictEqual(classifyError(error), ErrorCode.E_NOT_FILE);
});

void it('classifyError classifies Node.js ENOTDIR error code', () => {
  const error = Object.assign(new Error('not a directory'), {
    code: 'ENOTDIR',
  });
  assert.strictEqual(classifyError(error), ErrorCode.E_NOT_DIRECTORY);
});

void it('classifyError classifies Node.js ELOOP error code', () => {
  const error = Object.assign(new Error('too many symbolic links'), {
    code: 'ELOOP',
  });
  assert.strictEqual(classifyError(error), ErrorCode.E_SYMLINK_NOT_ALLOWED);
});

void it('classifyError classifies Node.js ETIMEDOUT error code', () => {
  const error = Object.assign(new Error('operation timed out'), {
    code: 'ETIMEDOUT',
  });
  assert.strictEqual(classifyError(error), ErrorCode.E_TIMEOUT);
});

void it('classifyError classifies McpError directly by its code', () => {
  const error = new McpError(
    ErrorCode.E_TOO_LARGE,
    'File too large',
    '/path/to/file'
  );
  assert.strictEqual(classifyError(error), ErrorCode.E_TOO_LARGE);
});
