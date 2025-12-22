import * as path from 'node:path';

import { expect, it } from 'vitest';

import { headFile } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('headFile returns first N lines', async () => {
  const content = await headFile(path.join(getTestDir(), 'multiline.txt'), 5);
  const lines = content.split('\n');
  expect(lines[0]).toBe('Line 1');
  expect(lines.length).toBeLessThanOrEqual(5);
});
