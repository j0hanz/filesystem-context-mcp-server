import * as path from 'node:path';

import { expect, it } from 'vitest';

import { tailFile } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('tailFile returns last N lines', async () => {
  const content = await tailFile(path.join(getTestDir(), 'multiline.txt'), 5);
  const lines = content.split('\n').filter((l) => l);
  expect(lines[lines.length - 1]).toBe('Line 100');
});
