import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFile } from '../../../lib/fs-helpers/readers/read-file.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('readFile edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    void it('readFile rejects when both head and tail are provided', async () => {
      await assert.rejects(
        readFile(path.join(getTestDir(), 'multiline.txt'), {
          head: 5,
          tail: 5,
        }),
        /Cannot specify multiple/
      );
    });

    void it('readFile rejects when lineRange and head are provided', async () => {
      await assert.rejects(
        readFile(path.join(getTestDir(), 'multiline.txt'), {
          lineRange: { start: 1, end: 5 },
          head: 5,
        }),
        /Cannot specify multiple/
      );
    });

    void it('readFile rejects invalid lineRange start', async () => {
      await assert.rejects(
        readFile(path.join(getTestDir(), 'multiline.txt'), {
          lineRange: { start: 0, end: 5 },
        }),
        /start must be at least 1/
      );
    });

    void it('readFile rejects lineRange where end < start', async () => {
      await assert.rejects(
        readFile(path.join(getTestDir(), 'multiline.txt'), {
          lineRange: { start: 10, end: 5 },
        }),
        /end.*must be >= start/
      );
    });

    void it('readFile handles reading beyond file length gracefully', async () => {
      const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
        lineRange: { start: 95, end: 200 },
      });
      assert.ok(result.content.includes('Line 100'));
      assert.strictEqual(result.truncated, true);
    });

    void it('readFile head read is not truncated when file is shorter than head', async () => {
      const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
        head: 200,
      });
      assert.ok(result.content.includes('Line 100'));
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.hasMoreLines, false);
    });

    void it('readFile tail read is not truncated when file is shorter than tail', async () => {
      const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
        tail: 200,
      });
      assert.ok(result.content.includes('Line 1'));
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.hasMoreLines, false);
    });

    void it('readFile handles empty file', async () => {
      const emptyFile = path.join(getTestDir(), 'empty-read.txt');
      await fs.writeFile(emptyFile, '');

      const result = await readFile(emptyFile);
      assert.strictEqual(result.content, '');
      assert.strictEqual(result.truncated, false);

      await fs.rm(emptyFile);
    });
  });
});
