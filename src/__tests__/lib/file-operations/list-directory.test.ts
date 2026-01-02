import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listDirectory } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('listDirectory', () => {
  withFileOpsFixture((getTestDir) => {
    void it('listDirectory lists directory contents', async () => {
      const result = await listDirectory(getTestDir());
      assert.ok(result.entries.length > 0);
      assert.ok(result.summary.totalEntries > 0);
    });

    void it('listDirectory throws when path is a file', async () => {
      await assert.rejects(
        listDirectory(path.join(getTestDir(), 'README.md')),
        /Not a directory/i
      );
    });

    void it('listDirectory lists recursively when specified', async () => {
      const result = await listDirectory(getTestDir(), { recursive: true });
      assert.strictEqual(
        result.entries.some((e) => e.name === 'index.ts'),
        true
      );
    });

    void it('listDirectory includes hidden files when specified', async () => {
      const result = await listDirectory(getTestDir(), { includeHidden: true });
      assert.strictEqual(
        result.entries.some((e) => e.name === '.hidden'),
        true
      );
    });

    void it('listDirectory excludes hidden files by default', async () => {
      const result = await listDirectory(getTestDir(), {
        includeHidden: false,
      });
      assert.strictEqual(
        result.entries.some((e) => e.name === '.hidden'),
        false
      );
    });

    void it('listDirectory respects maxEntries limit', async () => {
      const result = await listDirectory(getTestDir(), { maxEntries: 2 });
      assert.ok(result.entries.length <= 2);
      assert.strictEqual(result.summary.truncated, true);
    });
  });
});
