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

it('readMultipleFiles rejects line range with head/tail', async () => {
  const filePath = path.join(getTestDir(), 'multiline.txt');
  await expect(
    readMultipleFiles([filePath], {
      lineStart: 1,
      lineEnd: 2,
      head: 1,
    })
  ).rejects.toThrow('Cannot specify multiple');
});
