import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readMultipleFiles } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('readMultipleFiles', () => {
  withFileOpsFixture((getTestDir) => {
    void it('readMultipleFiles reads multiple files in parallel', async () => {
      const paths = [
        path.join(getTestDir(), 'README.md'),
        path.join(getTestDir(), 'src', 'index.ts'),
      ];
      const results = await readMultipleFiles(paths);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(
        results.every((r) => r.content !== undefined),
        true
      );
    });

    void it('readMultipleFiles handles individual file errors gracefully', async () => {
      const paths = [
        path.join(getTestDir(), 'README.md'),
        path.join(getTestDir(), 'non-existent.txt'),
      ];
      const results = await readMultipleFiles(paths);
      assert.strictEqual(results.length, 2);
      assert.ok(results[0]?.content);
      assert.ok(results[1]?.error);
    });

    void it('readMultipleFiles preserves requested paths for duplicates', async () => {
      const filePath = path.join(getTestDir(), 'README.md');
      const results = await readMultipleFiles([filePath, filePath]);
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0]?.path, filePath);
      assert.strictEqual(results[1]?.path, filePath);
    });

    void it('readMultipleFiles enforces total size cap for head/tail reads', async () => {
      const big1 = path.join(getTestDir(), 'big1.log');
      const big2 = path.join(getTestDir(), 'big2.log');
      const largeContent = 'A'.repeat(50_000);
      await fs.writeFile(big1, largeContent);
      await fs.writeFile(big2, largeContent);

      const results = await readMultipleFiles([big1, big2], {
        head: 1,
        maxTotalSize: 10,
      });

      assert.strictEqual(
        results.every((r) => r.error !== undefined),
        true
      );
      await Promise.all([fs.rm(big1), fs.rm(big2)]).catch(() => {});
    });

    void it('readMultipleFiles supports line range reads', async () => {
      const filePath = path.join(getTestDir(), 'multiline.txt');
      const results = await readMultipleFiles([filePath], {
        lineStart: 2,
        lineEnd: 4,
      });

      const content = results[0]?.content ?? '';
      assert.strictEqual(content.split('\n')[0], 'Line 2');
      assert.strictEqual(content.split('\n')[2], 'Line 4');
      assert.strictEqual(results[0]?.truncated, true);
    });
  });
});
