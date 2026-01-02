import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { headFile } from '../../../lib/fs-helpers.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('headFile edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('headFile handles requesting more lines than file has', async () => {
      const content = await headFile(
        path.join(getTestDir(), 'multiline.txt'),
        200
      );
      const lines = content.split('\n');
      assert.strictEqual(lines.length, 100);
    });

    void it('headFile handles empty file', async () => {
      const emptyFile = path.join(getTestDir(), 'empty-head.txt');
      await fs.writeFile(emptyFile, '');

      const content = await headFile(emptyFile, 5);
      assert.strictEqual(content, '');

      await fs.rm(emptyFile);
    });
  });
});
