import * as path from 'node:path';

import { expect, it } from 'vitest';

import { analyzeDirectory } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('analyzeDirectory analyzes directory structure', async () => {
  const result = await analyzeDirectory(getTestDir());
  expect(result.analysis.totalFiles).toBeGreaterThan(0);
  expect(result.analysis.totalDirectories).toBeGreaterThan(0);
  expect(result.analysis.totalSize).toBeGreaterThan(0);
});

it('analyzeDirectory respects maxEntries and marks truncated', async () => {
  const result = await analyzeDirectory(getTestDir(), { maxEntries: 1 });
  expect(result.summary.truncated).toBe(true);
  expect(
    result.analysis.totalFiles + result.analysis.totalDirectories
  ).toBeLessThanOrEqual(1);
});

it('analyzeDirectory lists file types', async () => {
  const result = await analyzeDirectory(getTestDir());
  expect(Object.keys(result.analysis.fileTypes).length).toBeGreaterThan(0);
});

it('analyzeDirectory tracks largest files', async () => {
  const result = await analyzeDirectory(getTestDir(), { topN: 5 });
  expect(result.analysis.largestFiles.length).toBeLessThanOrEqual(5);
});

it('analyzeDirectory throws when path is a file', async () => {
  await expect(
    analyzeDirectory(path.join(getTestDir(), 'README.md'))
  ).rejects.toThrow(/Not a directory/i);
});
