import * as path from 'node:path';

import { expect, it } from 'vitest';

import { readMediaFile } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('readMediaFile reads binary file as base64', async () => {
  const result = await readMediaFile(path.join(getTestDir(), 'image.png'));
  expect(result.mimeType).toBe('image/png');
  expect(result.data).toBeTruthy();
  expect(result.size).toBeGreaterThan(0);
});

it('readMediaFile returns correct MIME type for markdown files', async () => {
  const result = await readMediaFile(path.join(getTestDir(), 'README.md'));
  expect(result.mimeType).toBe('text/markdown');
  expect(result.data).toBeTruthy();
  expect(result.size).toBeGreaterThan(0);
});

it('readMediaFile rejects files too large', async () => {
  await expect(
    readMediaFile(path.join(getTestDir(), 'image.png'), { maxSize: 1 })
  ).rejects.toThrow('too large');
});
