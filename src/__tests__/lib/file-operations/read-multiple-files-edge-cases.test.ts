import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readMultipleFiles } from '../../../lib/file-operations/read-multiple-files.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

function registerReadMultipleEdgeBasics(getTestDir: () => string): void {
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
}

function registerReadMultipleEdgeDuplicates(getTestDir: () => string): void {
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
}

void describe('readMultipleFiles edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    registerReadMultipleEdgeBasics(getTestDir);
    registerReadMultipleEdgeDuplicates(getTestDir);
  });
});
