import * as path from 'node:path';

import { expect, it } from 'vitest';

import { listDirectory } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('listDirectory lists directory contents', async () => {
  const result = await listDirectory(getTestDir());
  expect(result.entries.length).toBeGreaterThan(0);
  expect(result.summary.totalEntries).toBeGreaterThan(0);
});

it('listDirectory throws when path is a file', async () => {
  await expect(
    listDirectory(path.join(getTestDir(), 'README.md'))
  ).rejects.toThrow(/Not a directory/i);
});

it('listDirectory lists recursively when specified', async () => {
  const result = await listDirectory(getTestDir(), { recursive: true });
  expect(result.entries.some((e) => e.name === 'index.ts')).toBe(true);
});

it('listDirectory includes hidden files when specified', async () => {
  const result = await listDirectory(getTestDir(), { includeHidden: true });
  expect(result.entries.some((e) => e.name === '.hidden')).toBe(true);
});

it('listDirectory excludes hidden files by default', async () => {
  const result = await listDirectory(getTestDir(), { includeHidden: false });
  expect(result.entries.some((e) => e.name === '.hidden')).toBe(false);
});

it('listDirectory respects maxEntries limit', async () => {
  const result = await listDirectory(getTestDir(), { maxEntries: 2 });
  expect(result.entries.length).toBeLessThanOrEqual(2);
  expect(result.summary.truncated).toBe(true);
});
