import { expect, it } from 'vitest';

import { analyzeDirectory } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('analyzeDirectory handles topN=1', async () => {
  const result = await analyzeDirectory(getTestDir(), { topN: 1 });
  expect(result.analysis.largestFiles.length).toBeLessThanOrEqual(1);
  expect(result.analysis.recentlyModified.length).toBeLessThanOrEqual(1);
});

it('analyzeDirectory correctly counts file types', async () => {
  const result = await analyzeDirectory(getTestDir());
  expect(result.analysis.fileTypes['.ts']).toBe(2);
  expect(result.analysis.fileTypes['.md']).toBe(2);
});
