import { expect, it } from 'vitest';

import { searchContent } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('searchContent handles empty search results', async () => {
  const result = await searchContent(getTestDir(), 'xyznonexistent123', {
    filePattern: '**/*.ts',
  });
  expect(result.matches.length).toBe(0);
  expect(result.summary.filesMatched).toBe(0);
});

it('searchContent handles special regex characters safely', async () => {
  const result = await searchContent(getTestDir(), 'hello\\.world', {
    filePattern: '**/*.ts',
  });
  expect(result).toBeDefined();
});

it('searchContent throws on invalid regex syntax', async () => {
  await expect(searchContent(getTestDir(), '(?')).rejects.toThrow(
    /Invalid regular expression|ReDoS/i
  );
});

it('searchContent respects maxResults limit', async () => {
  const result = await searchContent(getTestDir(), '\\w+', {
    filePattern: '**/*.ts',
    maxResults: 1,
  });
  expect(result.matches.length).toBeLessThanOrEqual(1);
  if (result.matches.length === 1) {
    expect(result.summary.truncated).toBe(true);
  }
});

it('searchContent respects maxFilesScanned limit', async () => {
  const result = await searchContent(getTestDir(), 'export', {
    filePattern: '**/*',
    maxFilesScanned: 1,
  });
  expect(result.summary.filesScanned).toBeLessThanOrEqual(1);
});

it('searchContent handles timeout correctly', async () => {
  const result = await searchContent(getTestDir(), 'export', {
    filePattern: '**/*',
    timeoutMs: 1,
  });
  expect(result).toBeDefined();
});

it('searchContent stops early when maxResults is 0', async () => {
  const result = await searchContent(getTestDir(), 'Line', { maxResults: 0 });
  expect(result.summary.truncated).toBe(true);
  expect(result.summary.stoppedReason).toBe('maxResults');
});

it('searchContent matches literal strings when isLiteral=true', async () => {
  const result = await searchContent(getTestDir(), 'Test.*Project', {
    isLiteral: true,
    filePattern: '**/*.md',
  });
  expect(result.matches.length).toBe(0);
});
