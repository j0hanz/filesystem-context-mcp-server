import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { computeChecksums } from '../../../lib/file-operations.js';
import { setAllowedDirectoriesResolved } from '../../../lib/path-validation.js';

let tempDir: string;
let testFile1: string;
let testFile2: string;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checksum-test-'));
  testFile1 = path.join(tempDir, 'file1.txt');
  testFile2 = path.join(tempDir, 'file2.txt');

  await fs.writeFile(testFile1, 'Hello World');
  await fs.writeFile(testFile2, 'Hello World'); // Same content

  await setAllowedDirectoriesResolved([tempDir]);
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

it('should compute SHA-256 checksums by default', async () => {
  const result = await computeChecksums([testFile1]);

  expect(result.summary.total).toBe(1);
  expect(result.summary.succeeded).toBe(1);
  expect(result.results[0]?.checksum).toBeDefined();
  expect(result.results[0]?.algorithm).toBe('sha256');
  expect(result.results[0]?.checksum).toHaveLength(64); // SHA-256 hex is 64 chars
});

it('should detect identical content with same checksum', async () => {
  const result = await computeChecksums([testFile1, testFile2]);

  expect(result.summary.succeeded).toBe(2);
  expect(result.results[0]?.checksum).toBe(result.results[1]?.checksum);
});

it('should support different algorithms', async () => {
  const md5Result = await computeChecksums([testFile1], { algorithm: 'md5' });
  const sha512Result = await computeChecksums([testFile1], {
    algorithm: 'sha512',
  });

  expect(md5Result.results[0]?.checksum).toHaveLength(32); // MD5 hex
  expect(sha512Result.results[0]?.checksum).toHaveLength(128); // SHA-512 hex
});

it('should support base64 encoding', async () => {
  const result = await computeChecksums([testFile1], { encoding: 'base64' });

  expect(result.results[0]?.checksum).toMatch(/^[A-Za-z0-9+/=]+$/);
});

it('should handle non-existent files gracefully', async () => {
  const nonExistent = path.join(tempDir, 'nonexistent.txt');
  const result = await computeChecksums([testFile1, nonExistent]);

  expect(result.summary.succeeded).toBe(1);
  expect(result.summary.failed).toBe(1);

  const errorResult = result.results.find((r) => r.path === nonExistent);
  expect(errorResult?.error).toBeDefined();
});

it('should return empty result for empty array', async () => {
  const result = await computeChecksums([]);

  expect(result.summary.total).toBe(0);
  expect(result.results).toHaveLength(0);
});
