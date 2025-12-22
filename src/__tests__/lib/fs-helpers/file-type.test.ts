import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { getFileType } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('getFileType identifies files', async () => {
  const stats = await fs.stat(path.join(getTestDir(), 'README.md'));
  expect(getFileType(stats)).toBe('file');
});

it('getFileType identifies directories', async () => {
  const stats = await fs.stat(getTestDir());
  expect(getFileType(stats)).toBe('directory');
});
