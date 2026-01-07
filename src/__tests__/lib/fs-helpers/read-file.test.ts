import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFile } from '../../../lib/fs-helpers/readers/read-file.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('readFile', () => {
  withFileOpsFixture((getTestDir) => {
    void it('readFile reads file contents', async () => {
      const result = await readFile(path.join(getTestDir(), 'README.md'));
      assert.ok(result.content.includes('# Test Project'));
    });

    void it('readFile reads specific line ranges', async () => {
      const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
        lineRange: { start: 1, end: 5 },
      });
      assert.ok(result.content.includes('Line 1'));
      assert.ok(result.content.includes('Line 5'));
      assert.strictEqual(result.truncated, true);
    });

    void it('readFile rejects non-files', async () => {
      await assert.rejects(readFile(getTestDir()), /Not a file/);
    });
  });
});
