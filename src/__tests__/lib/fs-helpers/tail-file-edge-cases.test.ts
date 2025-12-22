import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { tailFile } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('tailFile handles requesting more lines than file has', async () => {
  const content = await tailFile(path.join(getTestDir(), 'multiline.txt'), 200);
  const lines = content.split('\n').filter((l) => l);
  expect(lines.length).toBe(100);
});

it('tailFile handles empty file', async () => {
  const emptyFile = path.join(getTestDir(), 'empty-tail.txt');
  await fs.writeFile(emptyFile, '');

  const content = await tailFile(emptyFile, 5);
  expect(content).toBe('');

  await fs.rm(emptyFile);
});

it('tailFile handles single line file', async () => {
  const singleLineFile = path.join(getTestDir(), 'single-line.txt');
  await fs.writeFile(singleLineFile, 'Only one line');

  const content = await tailFile(singleLineFile, 5);
  expect(content).toBe('Only one line');

  await fs.rm(singleLineFile);
});
