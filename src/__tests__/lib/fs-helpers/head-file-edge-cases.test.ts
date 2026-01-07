import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { headFile } from '../../../lib/fs-helpers/readers/head-file.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('headFile edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('headFile handles requesting more lines than file has', async () => {
      const filePath = path.join(getTestDir(), 'multiline.txt');
      const handle = await fs.open(filePath, 'r');
      try {
        const content = await headFile(handle, 200);
        const lines = content.split('\n');
        assert.strictEqual(lines.length, 100);
      } finally {
        await handle.close();
      }
    });

    void it('headFile handles empty file', async () => {
      const emptyFile = path.join(getTestDir(), 'empty-head.txt');
      await fs.writeFile(emptyFile, '');
      const handle = await fs.open(emptyFile, 'r');
      try {
        const content = await headFile(handle, 5);
        assert.strictEqual(content, '');
      } finally {
        await handle.close();
      }
      await fs.rm(emptyFile);
    });
  });
});
