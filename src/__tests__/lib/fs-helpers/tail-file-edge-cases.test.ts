import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tailFile } from '../../../lib/fs-helpers.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('tailFile edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('tailFile handles requesting more lines than file has', async () => {
      const content = await tailFile(
        path.join(getTestDir(), 'multiline.txt'),
        200
      );
      const lines = content.split('\n').filter((l) => l);
      assert.strictEqual(lines.length, 100);
    });

    void it('tailFile handles empty file', async () => {
      const emptyFile = path.join(getTestDir(), 'empty-tail.txt');
      await fs.writeFile(emptyFile, '');

      const content = await tailFile(emptyFile, 5);
      assert.strictEqual(content, '');

      await fs.rm(emptyFile);
    });

    void it('tailFile handles single line file', async () => {
      const singleLineFile = path.join(getTestDir(), 'single-line.txt');
      await fs.writeFile(singleLineFile, 'Only one line');

      const content = await tailFile(singleLineFile, 5);
      assert.strictEqual(content, 'Only one line');

      await fs.rm(singleLineFile);
    });
  });
});
