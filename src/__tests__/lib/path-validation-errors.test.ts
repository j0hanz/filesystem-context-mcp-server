import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import { normalizePath } from '../../lib/path-utils.js';
import { setAllowedDirectories } from '../../lib/path-validation.js';
import {
  toAccessDeniedWithHint,
  toMcpError,
} from '../../lib/path-validation.js';

void describe('path-validation errors', () => {
  afterEach(() => {
    setAllowedDirectories([]);
  });

  void it('toMcpError maps known Node error codes', () => {
    const error = Object.assign(new Error('Missing'), { code: 'ENOENT' });

    const result = toMcpError('/missing', error);

    assert.strictEqual(result.code, ErrorCode.E_NOT_FOUND);
    assert.ok(result.message.includes('/missing'));
    assert.strictEqual(result.details?.originalCode, 'ENOENT');
  });

  void it('toMcpError falls back for unknown codes', () => {
    const error = Object.assign(new Error('Boom'), { code: 'EUNKNOWN' });

    const result = toMcpError('/path', error);

    assert.strictEqual(result.code, ErrorCode.E_NOT_FOUND);
    assert.ok(result.details);
    assert.strictEqual(result.details.originalCode, 'EUNKNOWN');
    assert.strictEqual(result.details.originalMessage, 'Boom');
  });

  void it('toAccessDeniedWithHint includes allowed directories', () => {
    const allowed = normalizePath(path.join(os.tmpdir(), 'allowed'));
    setAllowedDirectories([allowed]);

    const result = toAccessDeniedWithHint('/requested', '/resolved', allowed);

    assert.strictEqual(result.code, ErrorCode.E_ACCESS_DENIED);
    assert.ok(result.message.includes('Allowed:'));
    assert.ok(result.message.includes(allowed));
    assert.ok(result.details);
    assert.strictEqual(result.details.resolvedPath, '/resolved');
    assert.strictEqual(result.details.normalizedResolvedPath, allowed);
  });
});
