import { expect, it } from 'vitest';

import { searchFiles } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('searchFiles finds files by glob pattern', async () => {
  const result = await searchFiles(getTestDir(), '**/*.ts');
  expect(result.results.length).toBe(2);
  expect(result.results.some((r) => r.path.includes('index.ts'))).toBe(true);
  const first = result.results.find((r) => r.type === 'file');
  if (first) {
    expect(first.modified).toBeInstanceOf(Date);
  }
});

it('searchFiles finds markdown files', async () => {
  const result = await searchFiles(getTestDir(), '**/*.md');
  expect(result.results.length).toBe(2);
});

it('searchFiles returns empty results for non-matching patterns', async () => {
  const result = await searchFiles(getTestDir(), '**/*.xyz');
  expect(result.results.length).toBe(0);
});

it('searchFiles respects maxResults', async () => {
  const result = await searchFiles(getTestDir(), '**/*', [], { maxResults: 1 });
  expect(result.results.length).toBeLessThanOrEqual(1);
});
