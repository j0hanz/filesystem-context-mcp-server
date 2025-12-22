import * as path from 'node:path';

import { expect, it } from 'vitest';

import { readMultipleFiles } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('readMultipleFiles handles empty array', async () => {
  const results = await readMultipleFiles([]);
  expect(results.length).toBe(0);
});

it('readMultipleFiles handles all files failing', async () => {
  const paths = [
    path.join(getTestDir(), 'nonexistent1.txt'),
    path.join(getTestDir(), 'nonexistent2.txt'),
  ];
  const results = await readMultipleFiles(paths);
  expect(results.length).toBe(2);
  expect(results.every((r) => r.error !== undefined)).toBe(true);
});
