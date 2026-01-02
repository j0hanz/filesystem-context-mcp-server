import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getFileType } from '../../../lib/fs-helpers.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('getFileType', () => {
  withFileOpsFixture((getTestDir) => {
    void it('getFileType identifies files', async () => {
      const stats = await fs.stat(path.join(getTestDir(), 'README.md'));
      assert.strictEqual(getFileType(stats), 'file');
    });

    void it('getFileType identifies directories', async () => {
      const stats = await fs.stat(getTestDir());
      assert.strictEqual(getFileType(stats), 'directory');
    });
  });
});
