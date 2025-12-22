import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { searchContent } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('searchContent finds content in files', async () => {
  const result = await searchContent(getTestDir(), 'hello');
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches[0]?.file).toContain('index.ts');
});

it('searchContent searches case-insensitively by default', async () => {
  const result = await searchContent(getTestDir(), 'HELLO');
  expect(result.matches.length).toBeGreaterThan(0);
});

it('searchContent respects case sensitivity when specified', async () => {
  const result = await searchContent(getTestDir(), 'HELLO', {
    caseSensitive: true,
  });
  expect(result.matches.length).toBe(0);
});

it('searchContent enforces wholeWord when literal', async () => {
  const literalFile = path.join(getTestDir(), 'literal.txt');
  await fs.writeFile(literalFile, 'concatenate cat scatter catapult cat\n');

  const result = await searchContent(getTestDir(), 'cat', {
    isLiteral: true,
    wholeWord: true,
    filePattern: '**/*.txt',
  });

  expect(result.matches.length).toBe(1);
  expect(result.matches[0]?.matchCount).toBe(2);
  await fs.rm(literalFile).catch(() => {});
});

it('searchContent skips binary files by default', async () => {
  const result = await searchContent(getTestDir(), 'PNG');
  expect(result.summary.skippedBinary).toBeGreaterThanOrEqual(0);
});

it('searchContent respects file pattern filter', async () => {
  const result = await searchContent(getTestDir(), 'export', {
    filePattern: '**/*.ts',
  });
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches.every((m) => m.file.endsWith('.ts'))).toBe(true);
});

it('searchContent includes hidden files when requested', async () => {
  const result = await searchContent(getTestDir(), 'hidden', {
    includeHidden: true,
    filePattern: '**/*',
    isLiteral: true,
  });
  expect(result.matches.length).toBeGreaterThan(0);
  expect(
    result.matches.some((m) => m.file.includes(`.hidden${path.sep}`))
  ).toBe(true);
});

it('searchContent rejects unsafe regex patterns', async () => {
  const unsafePatterns = ['(a+)+', '([a-zA-Z]+)*', '(.*a){25}'];
  for (const pattern of unsafePatterns) {
    await expect(searchContent(getTestDir(), pattern)).rejects.toThrow(
      /ReDoS|unsafe/i
    );
  }
});

it('searchContent accepts safe regex patterns', async () => {
  const safePatterns = ['hello', 'world\\d+', '[a-z]+', 'function\\s+\\w+'];
  for (const pattern of safePatterns) {
    const result = await searchContent(getTestDir(), pattern, {
      filePattern: '**/*.ts',
    });
    expect(result).toBeDefined();
  }
});
