import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode, NODE_ERROR_CODE_MAP } from '../../lib/errors.js';

void it('NODE_ERROR_CODE_MAP maps common Node.js error codes', () => {
  assert.strictEqual(NODE_ERROR_CODE_MAP.ENOENT, ErrorCode.E_NOT_FOUND);
  assert.strictEqual(NODE_ERROR_CODE_MAP.EACCES, ErrorCode.E_PERMISSION_DENIED);
  assert.strictEqual(NODE_ERROR_CODE_MAP.EPERM, ErrorCode.E_PERMISSION_DENIED);
  assert.strictEqual(NODE_ERROR_CODE_MAP.EISDIR, ErrorCode.E_NOT_FILE);
  assert.strictEqual(NODE_ERROR_CODE_MAP.ENOTDIR, ErrorCode.E_NOT_DIRECTORY);
  assert.strictEqual(
    NODE_ERROR_CODE_MAP.ELOOP,
    ErrorCode.E_SYMLINK_NOT_ALLOWED
  );
  assert.strictEqual(NODE_ERROR_CODE_MAP.ETIMEDOUT, ErrorCode.E_TIMEOUT);
});

void it('NODE_ERROR_CODE_MAP handles resource exhaustion errors as timeout', () => {
  assert.strictEqual(NODE_ERROR_CODE_MAP.EMFILE, ErrorCode.E_TIMEOUT);
  assert.strictEqual(NODE_ERROR_CODE_MAP.ENFILE, ErrorCode.E_TIMEOUT);
});
