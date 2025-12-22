import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { readMultipleFiles } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('readMultipleFiles reads multiple files in parallel', async () => {
  const paths = [
    path.join(getTestDir(), 'README.md'),
    path.join(getTestDir(), 'src', 'index.ts'),
  ];
  const results = await readMultipleFiles(paths);
  expect(results.length).toBe(2);
  expect(results.every((r) => r.content !== undefined)).toBe(true);
});

it('readMultipleFiles handles individual file errors gracefully', async () => {
  const paths = [
    path.join(getTestDir(), 'README.md'),
    path.join(getTestDir(), 'non-existent.txt'),
  ];
  const results = await readMultipleFiles(paths);
  expect(results.length).toBe(2);
  expect(results[0]?.content).toBeDefined();
  expect(results[1]?.error).toBeDefined();
});

it('readMultipleFiles enforces total size cap for head/tail reads', async () => {
  const big1 = path.join(getTestDir(), 'big1.log');
  const big2 = path.join(getTestDir(), 'big2.log');
  const largeContent = 'A'.repeat(50_000);
  await fs.writeFile(big1, largeContent);
  await fs.writeFile(big2, largeContent);

  const results = await readMultipleFiles([big1, big2], {
    head: 1,
    maxTotalSize: 10,
  });

  expect(results.every((r) => r.error !== undefined)).toBe(true);
  await Promise.all([fs.rm(big1), fs.rm(big2)]).catch(() => {});
});
