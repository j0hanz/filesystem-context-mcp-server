import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { headFile } from '../../../lib/fs-helpers/readers/head-file.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('headFile', () => {
  withFileOpsFixture((getTestDir) => {
    void it('headFile returns first N lines', async () => {
      const filePath = path.join(getTestDir(), 'multiline.txt');
      const handle = await fs.open(filePath, 'r');
      try {
        const content = await headFile(handle, 5);
        const lines = content.split('\n');
        assert.strictEqual(lines[0], 'Line 1');
        assert.ok(lines.length <= 5);
      } finally {
        await handle.close();
      }
    });
  });
});
