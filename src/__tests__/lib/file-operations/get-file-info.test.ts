import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getFileInfo } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('getFileInfo', () => {
  withFileOpsFixture((getTestDir) => {
    void it('getFileInfo returns file metadata', async () => {
      const info = await getFileInfo(path.join(getTestDir(), 'README.md'));
      assert.strictEqual(info.name, 'README.md');
      assert.strictEqual(info.type, 'file');
      assert.ok(info.size > 0);
      assert.ok(info.created instanceof Date);
    });

    void it('getFileInfo returns directory metadata', async () => {
      const info = await getFileInfo(getTestDir());
      assert.strictEqual(info.type, 'directory');
    });
  });
});
