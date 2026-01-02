import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchFiles } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('searchFiles', () => {
  withFileOpsFixture((getTestDir) => {
    void it('searchFiles finds files by glob pattern', async () => {
      const result = await searchFiles(getTestDir(), '**/*.ts', [], {
        sortBy: 'modified',
      });
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(
        result.results.some((r) => r.path.includes('index.ts')),
        true
      );
      const first = result.results.find((r) => r.type === 'file');
      if (first) {
        assert.ok(first.modified instanceof Date);
      }
    });

    void it('searchFiles finds markdown files', async () => {
      const result = await searchFiles(getTestDir(), '**/*.md');
      assert.strictEqual(result.results.length, 2);
    });

    void it('searchFiles returns empty results for non-matching patterns', async () => {
      const result = await searchFiles(getTestDir(), '**/*.xyz');
      assert.strictEqual(result.results.length, 0);
    });

    void it('searchFiles respects maxResults', async () => {
      const result = await searchFiles(getTestDir(), '**/*', [], {
        maxResults: 1,
      });
      assert.ok(result.results.length <= 1);
    });

    void it('searchFiles rejects file base path', async () => {
      const filePath = path.join(getTestDir(), 'README.md');
      await assert.rejects(
        searchFiles(filePath, '**/*.ts'),
        /not a directory/i
      );
    });
  });
});
