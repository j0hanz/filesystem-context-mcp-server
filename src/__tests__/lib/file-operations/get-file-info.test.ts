import * as path from 'node:path';

import { expect, it } from 'vitest';

import { getFileInfo } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('getFileInfo returns file metadata', async () => {
  const info = await getFileInfo(path.join(getTestDir(), 'README.md'));
  expect(info.name).toBe('README.md');
  expect(info.type).toBe('file');
  expect(info.size).toBeGreaterThan(0);
  expect(info.created).toBeInstanceOf(Date);
});

it('getFileInfo returns directory metadata', async () => {
  const info = await getFileInfo(getTestDir());
  expect(info.type).toBe('directory');
});
