import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { listDirectory } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('listDirectory handles maxDepth=0', async () => {
  const result = await listDirectory(getTestDir(), {
    recursive: true,
    maxDepth: 0,
  });
  expect(result.summary.maxDepthReached).toBe(0);
});

it('listDirectory handles empty directory', async () => {
  const emptyDir = path.join(getTestDir(), 'empty-dir');
  await fs.mkdir(emptyDir, { recursive: true });

  const result = await listDirectory(emptyDir);
  expect(result.entries.length).toBe(0);

  await fs.rm(emptyDir, { recursive: true });
});
