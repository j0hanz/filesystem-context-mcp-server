import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listDirectory } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('listDirectory edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('listDirectory handles maxDepth=0', async () => {
      const result = await listDirectory(getTestDir(), {
        recursive: true,
        maxDepth: 0,
      });
      assert.strictEqual(result.summary.maxDepthReached, 0);
    });

    void it('listDirectory handles empty directory', async () => {
      const emptyDir = path.join(getTestDir(), 'empty-dir');
      await fs.mkdir(emptyDir, { recursive: true });

      const result = await listDirectory(emptyDir);
      assert.strictEqual(result.entries.length, 0);

      await fs.rm(emptyDir, { recursive: true });
    });
  });
});
