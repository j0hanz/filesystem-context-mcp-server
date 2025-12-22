import { expect, it } from 'vitest';

import { ErrorCode, NODE_ERROR_CODE_MAP } from '../../lib/errors.js';

it('NODE_ERROR_CODE_MAP maps common Node.js error codes', () => {
  expect(NODE_ERROR_CODE_MAP.ENOENT).toBe(ErrorCode.E_NOT_FOUND);
  expect(NODE_ERROR_CODE_MAP.EACCES).toBe(ErrorCode.E_PERMISSION_DENIED);
  expect(NODE_ERROR_CODE_MAP.EPERM).toBe(ErrorCode.E_PERMISSION_DENIED);
  expect(NODE_ERROR_CODE_MAP.EISDIR).toBe(ErrorCode.E_NOT_FILE);
  expect(NODE_ERROR_CODE_MAP.ENOTDIR).toBe(ErrorCode.E_NOT_DIRECTORY);
  expect(NODE_ERROR_CODE_MAP.ELOOP).toBe(ErrorCode.E_SYMLINK_NOT_ALLOWED);
  expect(NODE_ERROR_CODE_MAP.ETIMEDOUT).toBe(ErrorCode.E_TIMEOUT);
});

it('NODE_ERROR_CODE_MAP handles resource exhaustion errors as timeout', () => {
  expect(NODE_ERROR_CODE_MAP.EMFILE).toBe(ErrorCode.E_TIMEOUT);
  expect(NODE_ERROR_CODE_MAP.ENFILE).toBe(ErrorCode.E_TIMEOUT);
});
