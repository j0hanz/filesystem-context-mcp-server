import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { headFile } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('headFile handles requesting more lines than file has', async () => {
  const content = await headFile(path.join(getTestDir(), 'multiline.txt'), 200);
  const lines = content.split('\n');
  expect(lines.length).toBe(100);
});

it('headFile handles empty file', async () => {
  const emptyFile = path.join(getTestDir(), 'empty-head.txt');
  await fs.writeFile(emptyFile, '');

  const content = await headFile(emptyFile, 5);
  expect(content).toBe('');

  await fs.rm(emptyFile);
});
