import * as path from 'node:path';

import { expect, it } from 'vitest';

import { readFile } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('readFile reads file contents', async () => {
  const result = await readFile(path.join(getTestDir(), 'README.md'));
  expect(result.content).toContain('# Test Project');
});

it('readFile reads specific line ranges', async () => {
  const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
    lineRange: { start: 1, end: 5 },
  });
  expect(result.content).toContain('Line 1');
  expect(result.content).toContain('Line 5');
  expect(result.truncated).toBe(true);
});

it('readFile rejects non-files', async () => {
  await expect(readFile(getTestDir())).rejects.toThrow('Not a file');
});
