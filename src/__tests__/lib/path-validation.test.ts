import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { normalizePath } from '../../lib/path-utils.js';
import {
  getAllowedDirectories,
  setAllowedDirectories,
  validateExistingPath,
} from '../../lib/path-validation.js';

let testDir = '';
let subDir = '';
let testFile = '';

beforeAll(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
  subDir = path.join(testDir, 'subdir');
  await fs.mkdir(subDir);
  testFile = path.join(subDir, 'test.txt');
  await fs.writeFile(testFile, 'test content');
  setAllowedDirectories([normalizePath(testDir)]);
});

afterAll(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

function resetAllowedDirectories(): void {
  setAllowedDirectories([normalizePath(testDir)]);
}

async function createFileInDir(
  dirName: string,
  fileName: string
): Promise<string> {
  const dirPath = path.join(testDir, dirName);
  await fs.mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, fileName);
  await fs.writeFile(filePath, 'content');
  return filePath;
}

it('setAllowedDirectories and getAllowedDirectories set and get allowed directories', () => {
  const dirs = ['/test/dir1', '/test/dir2'];
  setAllowedDirectories(dirs.map(normalizePath));
  const result = getAllowedDirectories();
  expect(result.length).toBe(2);
  resetAllowedDirectories();
});

it('setAllowedDirectories returns empty array when no directories set', () => {
  setAllowedDirectories([]);
  expect(getAllowedDirectories()).toEqual([]);
  resetAllowedDirectories();
});

it('validateExistingPath allows paths within allowed directories', async () => {
  const result = await validateExistingPath(testFile);
  expect(result).toContain('test.txt');
});

it('validateExistingPath allows the allowed directory itself', async () => {
  const result = await validateExistingPath(testDir);
  expect(result).toBeTruthy();
});

it('validateExistingPath allows subdirectories within allowed directories', async () => {
  const result = await validateExistingPath(subDir);
  expect(result).toContain('subdir');
});

it('validateExistingPath rejects paths outside allowed directories', async () => {
  await expect(validateExistingPath('/etc/passwd')).rejects.toThrow();
});

it('validateExistingPath rejects traversal attempts', async () => {
  const traversalPath = path.join(testDir, '..', 'etc', 'passwd');
  await expect(validateExistingPath(traversalPath)).rejects.toThrow();
});

it('validateExistingPath rejects non-existent paths', async () => {
  const nonExistent = path.join(testDir, 'non-existent-file.txt');
  await expect(validateExistingPath(nonExistent)).rejects.toThrow();
});

it('validateExistingPath allows paths when filesystem root is allowed', async () => {
  const rootDir = path.parse(testDir).root;
  setAllowedDirectories([normalizePath(rootDir)]);
  const result = await validateExistingPath(testFile);
  expect(result).toContain('test.txt');
  resetAllowedDirectories();
});

it('validateExistingPath handles paths with spaces', async () => {
  const fileInDir = await createFileInDir('dir with spaces', 'file.txt');
  const result = await validateExistingPath(fileInDir);
  expect(result).toContain('file.txt');
  await fs.rm(path.dirname(fileInDir), { recursive: true });
});

it('validateExistingPath handles paths with special characters', async () => {
  const fileInDir = await createFileInDir(
    'special-chars_123',
    'test_file-1.txt'
  );
  const result = await validateExistingPath(fileInDir);
  expect(result).toContain('test_file-1.txt');
  await fs.rm(path.dirname(fileInDir), { recursive: true });
});

it('validateExistingPath rejects empty path', async () => {
  await expect(validateExistingPath('')).rejects.toThrow(/empty|whitespace/i);
});

it('validateExistingPath rejects whitespace-only path', async () => {
  await expect(validateExistingPath('   ')).rejects.toThrow(
    /empty|whitespace/i
  );
});

it('validateExistingPath rejects path with null bytes', async () => {
  const pathWithNull = path.join(testDir, 'file\0name.txt');
  await expect(validateExistingPath(pathWithNull)).rejects.toThrow();
});
