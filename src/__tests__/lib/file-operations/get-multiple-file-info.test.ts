import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { getMultipleFileInfo } from '../../../lib/file-operations.js';
import { setAllowedDirectoriesResolved } from '../../../lib/path-validation.js';

let tempDir: string;
let testFile1: string;
let testFile2: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfi-test-'));
  testFile1 = path.join(tempDir, 'file1.txt');
  testFile2 = path.join(tempDir, 'file2.json');

  await fs.writeFile(testFile1, 'Hello World');
  await fs.writeFile(testFile2, '{"key": "value"}');

  await setAllowedDirectoriesResolved([tempDir]);
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

it('should return info for multiple files', async () => {
  const result = await getMultipleFileInfo([testFile1, testFile2]);

  expect(result.summary.total).toBe(2);
  expect(result.summary.succeeded).toBe(2);
  expect(result.summary.failed).toBe(0);
  expect(result.results).toHaveLength(2);

  const info1 = result.results.find((r) => r.path === testFile1)?.info;
  expect(info1).toBeDefined();
  expect(info1?.name).toBe('file1.txt');
  expect(info1?.type).toBe('file');
});

it('should handle non-existent files gracefully', async () => {
  const nonExistent = path.join(tempDir, 'nonexistent.txt');
  const result = await getMultipleFileInfo([testFile1, nonExistent]);

  expect(result.summary.total).toBe(2);
  expect(result.summary.succeeded).toBe(1);
  expect(result.summary.failed).toBe(1);

  const errorResult = result.results.find((r) => r.path === nonExistent);
  expect(errorResult?.error).toBeDefined();
});

it('should return empty result for empty array', async () => {
  const result = await getMultipleFileInfo([]);

  expect(result.summary.total).toBe(0);
  expect(result.results).toHaveLength(0);
});
