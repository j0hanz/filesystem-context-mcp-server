import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readMultipleFiles } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('readMultipleFiles edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('readMultipleFiles handles empty array', async () => {
      const results = await readMultipleFiles([]);
      assert.strictEqual(results.length, 0);
    });

    void it('readMultipleFiles handles all files failing', async () => {
      const paths = [
        path.join(getTestDir(), 'nonexistent1.txt'),
        path.join(getTestDir(), 'nonexistent2.txt'),
      ];
      const results = await readMultipleFiles(paths);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(
        results.every((r) => r.error !== undefined),
        true
      );
    });

    void it('readMultipleFiles rejects line range with head/tail', async () => {
      const filePath = path.join(getTestDir(), 'multiline.txt');
      await assert.rejects(
        readMultipleFiles([filePath], {
          lineStart: 1,
          lineEnd: 2,
          head: 1,
        }),
        /Cannot specify multiple/
      );
    });

    void it('readMultipleFiles applies maxTotalSize per entry even with duplicates', async () => {
      const filePath = path.join(getTestDir(), 'big-duplicate.log');
      const largeContent = 'A'.repeat(50_000);
      await fs.writeFile(filePath, largeContent);

      const results = await readMultipleFiles([filePath, filePath], {
        head: 1,
        maxTotalSize: 10,
      });

      assert.strictEqual(results.length, 2);
      assert.strictEqual(
        results.every((r) => r.error !== undefined),
        true
      );
      await fs.rm(filePath).catch(() => {});
    });
  });
});
