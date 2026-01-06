import assert from 'node:assert/strict';
import { it } from 'node:test';

import { createDetailedError, ErrorCode, McpError } from '../../lib/errors.js';

const cases = [
  {
    name: 'ENOENT messages as not found',
    error: new Error('ENOENT: no such file or directory'),
    code: ErrorCode.E_NOT_FOUND,
  },
  {
    name: 'unknown message-only errors as unknown',
    error: new Error('Some random error'),
    code: ErrorCode.E_UNKNOWN,
  },
  {
    name: 'string errors with ENOENT as not found',
    error: 'ENOENT error',
    code: ErrorCode.E_NOT_FOUND,
  },
  {
    name: 'non-Error objects as unknown',
    error: { message: 'permission denied' },
    code: ErrorCode.E_UNKNOWN,
  },
  {
    name: 'Node.js EACCES error code as permission denied',
    error: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    code: ErrorCode.E_PERMISSION_DENIED,
  },
  {
    name: 'Node.js EPERM error code as permission denied',
    error: Object.assign(new Error('operation not permitted'), {
      code: 'EPERM',
    }),
    code: ErrorCode.E_PERMISSION_DENIED,
  },
  {
    name: 'Node.js EISDIR error code as not file',
    error: Object.assign(new Error('is a directory'), { code: 'EISDIR' }),
    code: ErrorCode.E_NOT_FILE,
  },
  {
    name: 'Node.js ENOTDIR error code as not directory',
    error: Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }),
    code: ErrorCode.E_NOT_DIRECTORY,
  },
  {
    name: 'Node.js ELOOP error code as symlink not allowed',
    error: Object.assign(new Error('too many symbolic links'), {
      code: 'ELOOP',
    }),
    code: ErrorCode.E_SYMLINK_NOT_ALLOWED,
  },
  {
    name: 'Node.js ETIMEDOUT error code as timeout',
    error: Object.assign(new Error('operation timed out'), {
      code: 'ETIMEDOUT',
    }),
    code: ErrorCode.E_TIMEOUT,
  },
  {
    name: 'McpError direct code',
    error: new McpError(
      ErrorCode.E_TOO_LARGE,
      'File too large',
      '/path/to/file'
    ),
    code: ErrorCode.E_TOO_LARGE,
  },
];

cases.forEach(({ name, error, code }) => {
  void it(`createDetailedError classifies ${name}`, () => {
    const detailed = createDetailedError(error);
    assert.strictEqual(detailed.code, code);
  });
});
