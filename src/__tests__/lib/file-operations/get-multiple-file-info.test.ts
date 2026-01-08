import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { getMultipleFileInfo } from '../../../lib/file-operations/get-multiple-file-info.js';
import { setAllowedDirectoriesResolved } from '../../../lib/path-validation/allowed-directories.js';

interface TestFixture {
  tempDir: string;
  testFile1: string;
  testFile2: string;
}

async function setupFixture(): Promise<TestFixture> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfi-test-'));
  const testFile1 = path.join(tempDir, 'file1.txt');
  const testFile2 = path.join(tempDir, 'file2.json');

  await fs.writeFile(testFile1, 'Hello World');
  await fs.writeFile(testFile2, '{"key": "value"}');

  await setAllowedDirectoriesResolved([tempDir]);
  return { tempDir, testFile1, testFile2 };
}

async function cleanupFixture(tempDir: string): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
}

function registerMultiFileInfoBasics(getFixture: () => TestFixture): void {
  void it('should return info for multiple files', async () => {
    const { testFile1, testFile2 } = getFixture();
    const result = await getMultipleFileInfo([testFile1, testFile2]);

    assert.strictEqual(result.summary.total, 2);
    assert.strictEqual(result.summary.succeeded, 2);
    assert.strictEqual(result.summary.failed, 0);
    assert.strictEqual(result.results.length, 2);

    const info1 = result.results.find((r) => r.path === testFile1)?.info;
    assert.ok(info1);
    assert.strictEqual(info1.name, 'file1.txt');
    assert.strictEqual(info1.type, 'file');
  });
}

function registerMultiFileInfoMissing(getFixture: () => TestFixture): void {
  void it('should handle non-existent files gracefully', async () => {
    const { tempDir, testFile1 } = getFixture();
    const nonExistent = path.join(tempDir, 'nonexistent.txt');
    const result = await getMultipleFileInfo([testFile1, nonExistent]);

    assert.strictEqual(result.summary.total, 2);
    assert.strictEqual(result.summary.succeeded, 1);
    assert.strictEqual(result.summary.failed, 1);

    const errorResult = result.results.find((r) => r.path === nonExistent);
    assert.ok(errorResult?.error);
  });
}

function registerMultiFileInfoEmpty(): void {
  void it('should return empty result for empty array', async () => {
    const result = await getMultipleFileInfo([]);

    assert.strictEqual(result.summary.total, 0);
    assert.strictEqual(result.results.length, 0);
  });
}

void describe('getMultipleFileInfo', () => {
  let fixture: TestFixture;

  before(async () => {
    fixture = await setupFixture();
  });

  after(async () => {
    await cleanupFixture(fixture.tempDir);
  });

  const getFixture = (): TestFixture => fixture;
  registerMultiFileInfoBasics(getFixture);
  registerMultiFileInfoMissing(getFixture);
  registerMultiFileInfoEmpty();
});
