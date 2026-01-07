import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import { normalizePath } from '../../lib/path-utils.js';
import { setAllowedDirectoriesResolved } from '../../lib/path-validation/allowed-directories.js';
import { toAccessDeniedWithHint } from '../../lib/path-validation/path-errors.js';

void describe('path-validation errors', () => {
  afterEach(async () => {
    await setAllowedDirectoriesResolved([]);
  });

  void it('toAccessDeniedWithHint includes allowed directories', async () => {
    const allowed = normalizePath(path.join(os.tmpdir(), 'allowed'));
    await setAllowedDirectoriesResolved([allowed]);

    const result = toAccessDeniedWithHint('/requested', '/resolved', allowed);

    assert.strictEqual(result.code, ErrorCode.E_ACCESS_DENIED);
    assert.ok(result.message.includes('Allowed:'));
    assert.ok(result.message.includes(allowed));
    assert.ok(result.details);
    assert.strictEqual(result.details.resolvedPath, '/resolved');
    assert.strictEqual(result.details.normalizedResolvedPath, allowed);
  });
});
