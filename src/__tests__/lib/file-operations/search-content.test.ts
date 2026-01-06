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
      assert.strictEqual(result.matches[0]?.contextBefore, undefined);
      assert.strictEqual(result.matches[0]?.contextAfter, undefined);
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

    void it('searchContent matches case-insensitively when literal', async () => {
      const literalFile = path.join(
        getTestDir(),
        'literal-case-insensitive.txt'
      );
      await fs.writeFile(
        literalFile,
        'ZzTestToken zztesttoken ZZTESTTOKEN zZtEsTtOkEn\n'
      );

      const result = await searchContent(getTestDir(), 'zztesttoken', {
        isLiteral: true,
        filePattern: '**/*.txt',
      });

      assert.strictEqual(result.matches.length, 1);
      assert.strictEqual(result.matches[0]?.matchCount, 4);
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

    const unsafePatterns = ['(a+)+', '([a-zA-Z]+)*', '(.*a){25}'];
    unsafePatterns.forEach((pattern) => {
      void it(`searchContent rejects unsafe regex pattern "${pattern}"`, async () => {
        await assert.rejects(
          searchContent(getTestDir(), pattern),
          /ReDoS|unsafe/i
        );
      });
    });

    const safePatterns = ['hello', 'world\\d+', '[a-z]+', 'function\\s+\\w+'];
    safePatterns.forEach((pattern) => {
      void it(`searchContent accepts safe regex pattern "${pattern}"`, async () => {
        const result = await searchContent(getTestDir(), pattern, {
          filePattern: '**/*.ts',
        });
        assert.ok(result);
      });
    });

    void it('searchContent returns context lines when requested', async () => {
      const result = await searchContent(getTestDir(), 'hello', {
        filePattern: '**/*.ts',
        contextLines: 1,
      });

      assert.ok(result.matches.length > 0);
      const firstMatch = result.matches[0];
      assert.ok(firstMatch !== undefined);
      assert.ok(Array.isArray(firstMatch.contextBefore));
      assert.ok(Array.isArray(firstMatch.contextAfter));
    });
  });
});
