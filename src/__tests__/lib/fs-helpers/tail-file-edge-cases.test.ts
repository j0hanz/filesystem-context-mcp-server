import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tailFile } from '../../../lib/fs-helpers/readers/tail-file.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('tailFile edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('tailFile handles requesting more lines than file has', async () => {
      const filePath = path.join(getTestDir(), 'multiline.txt');
      const stats = await fs.stat(filePath);
      const handle = await fs.open(filePath, 'r');
      try {
        const content = await tailFile(handle, stats.size, 200);
        const lines = content.split('\n').filter((l) => l);
        assert.strictEqual(lines.length, 100);
      } finally {
        await handle.close();
      }
    });

    void it('tailFile handles empty file', async () => {
      const emptyFile = path.join(getTestDir(), 'empty-tail.txt');
      await fs.writeFile(emptyFile, '');
      const stats = await fs.stat(emptyFile);
      const handle = await fs.open(emptyFile, 'r');
      try {
        const content = await tailFile(handle, stats.size, 5);
        assert.strictEqual(content, '');
      } finally {
        await handle.close();
      }
      await fs.rm(emptyFile);
    });

    void it('tailFile handles single line file', async () => {
      const singleLineFile = path.join(getTestDir(), 'single-line.txt');
      await fs.writeFile(singleLineFile, 'Only one line');
      const stats = await fs.stat(singleLineFile);
      const handle = await fs.open(singleLineFile, 'r');
      try {
        const content = await tailFile(handle, stats.size, 5);
        assert.strictEqual(content, 'Only one line');
      } finally {
        await handle.close();
      }
      await fs.rm(singleLineFile);
    });
  });
});
