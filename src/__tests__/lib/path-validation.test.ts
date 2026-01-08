import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { normalizePath } from '../../lib/path-utils.js';
import {
  getAllowedDirectories,
  setAllowedDirectoriesResolved,
} from '../../lib/path-validation/allowed-directories.js';
import { validateExistingPath } from '../../lib/path-validation/validate-existing.js';

interface TestFixture {
  testDir: string;
  subDir: string;
  testFile: string;
}

async function setupFixture(): Promise<TestFixture> {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
  const subDir = path.join(testDir, 'subdir');
  await fs.mkdir(subDir);
  const testFile = path.join(subDir, 'test.txt');
  await fs.writeFile(testFile, 'test content');
  await setAllowedDirectoriesResolved([normalizePath(testDir)]);
  return { testDir, subDir, testFile };
}

async function cleanupFixture(testDir: string): Promise<void> {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

async function resetAllowedDirectories(testDir: string): Promise<void> {
  await setAllowedDirectoriesResolved([normalizePath(testDir)]);
}

async function createFileInDir(
  testDir: string,
  dirName: string,
  fileName: string
): Promise<string> {
  const dirPath = path.join(testDir, dirName);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, fileName);
  await fs.writeFile(filePath, 'content');
  return filePath;
}

function registerAllowedDirectoryTests(getFixture: () => TestFixture): void {
  void it('setAllowedDirectories and getAllowedDirectories set and get allowed directories', async () => {
    const dirs = ['/test/dir1', '/test/dir2'];
    await setAllowedDirectoriesResolved(dirs.map(normalizePath));
    const result = getAllowedDirectories();
    assert.strictEqual(result.length, 2);
    await resetAllowedDirectories(getFixture().testDir);
  });

  void it('setAllowedDirectories returns empty array when no directories set', async () => {
    await setAllowedDirectoriesResolved([]);
    assert.deepStrictEqual(getAllowedDirectories(), []);
    await resetAllowedDirectories(getFixture().testDir);
  });
}

function registerNoAllowedDirectoryTest(getFixture: () => TestFixture): void {
  void it('validateExistingPath rejects when no allowed directories configured', async () => {
    await setAllowedDirectoriesResolved([]);
    await assert.rejects(
      validateExistingPath(getFixture().testFile),
      /no allowed directories configured/i
    );
    await resetAllowedDirectories(getFixture().testDir);
  });
}

function registerAllowedPathTests(getFixture: () => TestFixture): void {
  void it('validateExistingPath allows paths within allowed directories', async () => {
    const result = await validateExistingPath(getFixture().testFile);
    assert.ok(result.includes('test.txt'));
  });

  void it('validateExistingPath allows the allowed directory itself', async () => {
    const result = await validateExistingPath(getFixture().testDir);
    assert.ok(result);
  });

  void it('validateExistingPath allows subdirectories within allowed directories', async () => {
    const result = await validateExistingPath(getFixture().subDir);
    assert.ok(result.includes('subdir'));
  });
}

function registerRejectedPathTests(getFixture: () => TestFixture): void {
  void it('validateExistingPath rejects paths outside allowed directories', async () => {
    await assert.rejects(validateExistingPath('/etc/passwd'));
  });

  void it('validateExistingPath rejects traversal attempts', async () => {
    const traversalPath = path.join(
      getFixture().testDir,
      '..',
      'etc',
      'passwd'
    );
    await assert.rejects(validateExistingPath(traversalPath));
  });

  void it('validateExistingPath rejects non-existent paths', async () => {
    const nonExistent = path.join(
      getFixture().testDir,
      'non-existent-file.txt'
    );
    await assert.rejects(validateExistingPath(nonExistent));
  });
}

function registerSpecialPathTests(getFixture: () => TestFixture): void {
  void it('validateExistingPath allows paths when filesystem root is allowed', async () => {
    const rootDir = path.parse(getFixture().testDir).root;
    await setAllowedDirectoriesResolved([normalizePath(rootDir)]);
    const result = await validateExistingPath(getFixture().testFile);
    assert.ok(result.includes('test.txt'));
    await resetAllowedDirectories(getFixture().testDir);
  });

  void it('validateExistingPath handles paths with spaces', async () => {
    const fileInDir = await createFileInDir(
      getFixture().testDir,
      'dir with spaces',
      'file.txt'
    );
    const result = await validateExistingPath(fileInDir);
    assert.ok(result.includes('file.txt'));
    await fs.rm(path.dirname(fileInDir), { recursive: true });
  });

  void it('validateExistingPath handles paths with special characters', async () => {
    const fileInDir = await createFileInDir(
      getFixture().testDir,
      'special-chars_123',
      'test_file-1.txt'
    );
    const result = await validateExistingPath(fileInDir);
    assert.ok(result.includes('test_file-1.txt'));
    await fs.rm(path.dirname(fileInDir), { recursive: true });
  });
}

function registerInvalidInputTests(getFixture: () => TestFixture): void {
  void it('validateExistingPath rejects empty path', async () => {
    await assert.rejects(validateExistingPath(''), /empty|whitespace/i);
  });

  void it('validateExistingPath rejects whitespace-only path', async () => {
    await assert.rejects(validateExistingPath('   '), /empty|whitespace/i);
  });

  void it('validateExistingPath rejects path with null bytes', async () => {
    const pathWithNull = path.join(getFixture().testDir, 'file\0name.txt');
    await assert.rejects(validateExistingPath(pathWithNull));
  });
}

void describe('path-validation', () => {
  let fixture: TestFixture;

  before(async () => {
    fixture = await setupFixture();
  });

  after(async () => {
    await cleanupFixture(fixture.testDir);
  });

  const getFixture = (): TestFixture => fixture;
  registerAllowedDirectoryTests(getFixture);
  registerNoAllowedDirectoryTest(getFixture);
  registerAllowedPathTests(getFixture);
  registerRejectedPathTests(getFixture);
  registerSpecialPathTests(getFixture);
  registerInvalidInputTests(getFixture);
});
