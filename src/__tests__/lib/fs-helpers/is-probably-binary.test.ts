import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { isProbablyBinary } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('isProbablyBinary identifies binary files', async () => {
  const isBinary = await isProbablyBinary(path.join(getTestDir(), 'image.png'));
  expect(isBinary).toBe(true);
});

it('isProbablyBinary identifies text files', async () => {
  const isBinary = await isProbablyBinary(path.join(getTestDir(), 'README.md'));
  expect(isBinary).toBe(false);
});

it('isProbablyBinary identifies empty files as text', async () => {
  const emptyFile = path.join(getTestDir(), 'empty.txt');
  await fs.writeFile(emptyFile, '');
  const isBinary = await isProbablyBinary(emptyFile);
  expect(isBinary).toBe(false);
  await fs.rm(emptyFile);
});

it('isProbablyBinary identifies UTF-8 BOM files as text', async () => {
  const bomFile = path.join(getTestDir(), 'bom.txt');
  const content = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('Hello World'),
  ]);
  await fs.writeFile(bomFile, content);
  const isBinary = await isProbablyBinary(bomFile);
  expect(isBinary).toBe(false);
  await fs.rm(bomFile);
});
