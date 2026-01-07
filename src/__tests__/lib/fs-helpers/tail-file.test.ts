import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tailFile } from '../../../lib/fs-helpers/readers/tail-file.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('tailFile', () => {
  withFileOpsFixture((getTestDir) => {
    void it('tailFile returns last N lines', async () => {
      const filePath = path.join(getTestDir(), 'multiline.txt');
      const stats = await fs.stat(filePath);
      const handle = await fs.open(filePath, 'r');
      try {
        const content = await tailFile(handle, stats.size, 5);
        const lines = content.split('\n').filter((l) => l);
        assert.strictEqual(lines[lines.length - 1], 'Line 100');
      } finally {
        await handle.close();
      }
    });
  });
});
