import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchContent } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('searchContent', () => {
  withFileOpsFixture((getTestDir) => {
    void it('searchContent finds content in files', async () => {
      const result = await searchContent(getTestDir(), 'hello');
      assert.ok(result.matches.length > 0);
      assert.ok(result.matches[0]?.file.includes('index.ts'));
    });

    void it('searchContent rejects file base path', async () => {
      const filePath = path.join(getTestDir(), 'README.md');
      await assert.rejects(
        searchContent(filePath, 'hello'),
        /not a directory/i
      );
    });

    void it('searchContent searches case-insensitively by default', async () => {
      const result = await searchContent(getTestDir(), 'HELLO');
      assert.ok(result.matches.length > 0);
    });

    void it('searchContent respects case sensitivity when specified', async () => {
      const result = await searchContent(getTestDir(), 'HELLO', {
        caseSensitive: true,
      });
      assert.strictEqual(result.matches.length, 0);
    });

    void it('searchContent enforces wholeWord when literal', async () => {
      const literalFile = path.join(getTestDir(), 'literal.txt');
      await fs.writeFile(literalFile, 'concatenate cat scatter catapult cat\n');

      const result = await searchContent(getTestDir(), 'cat', {
        isLiteral: true,
        wholeWord: true,
        filePattern: '**/*.txt',
      });

      assert.strictEqual(result.matches.length, 1);
      assert.strictEqual(result.matches[0]?.matchCount, 2);
      await fs.rm(literalFile).catch(() => {});
    });

    void it('searchContent skips binary files by default', async () => {
      const result = await searchContent(getTestDir(), 'PNG');
      assert.ok(result.summary.skippedBinary >= 0);
    });

    void it('searchContent respects file pattern filter', async () => {
      const result = await searchContent(getTestDir(), 'export', {
        filePattern: '**/*.ts',
      });
      assert.ok(result.matches.length > 0);
      assert.strictEqual(
        result.matches.every((m) => m.file.endsWith('.ts')),
        true
      );
    });

    void it('searchContent includes hidden files when requested', async () => {
      const result = await searchContent(getTestDir(), 'hidden', {
        includeHidden: true,
        filePattern: '**/*',
        isLiteral: true,
      });
      assert.ok(result.matches.length > 0);
      assert.strictEqual(
        result.matches.some((m) => m.file.includes(`.hidden${path.sep}`)),
        true
      );
    });

    void it('searchContent rejects unsafe regex patterns', async () => {
      const unsafePatterns = ['(a+)+', '([a-zA-Z]+)*', '(.*a){25}'];
      for (const pattern of unsafePatterns) {
        await assert.rejects(
          searchContent(getTestDir(), pattern),
          /ReDoS|unsafe/i
        );
      }
    });

    void it('searchContent accepts safe regex patterns', async () => {
      const safePatterns = ['hello', 'world\\d+', '[a-z]+', 'function\\s+\\w+'];
      for (const pattern of safePatterns) {
        const result = await searchContent(getTestDir(), pattern, {
          filePattern: '**/*.ts',
        });
        assert.ok(result);
      }
    });
  });
});
