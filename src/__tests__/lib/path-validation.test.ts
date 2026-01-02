import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { normalizePath } from '../../lib/path-utils.js';
import {
  getAllowedDirectories,
  setAllowedDirectories,
  validateExistingPath,
} from '../../lib/path-validation.js';

void describe('path-validation', () => {
  let testDir = '';
  let subDir = '';
  let testFile = '';

  before(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
    subDir = path.join(testDir, 'subdir');
    await fs.mkdir(subDir);
    testFile = path.join(subDir, 'test.txt');
    await fs.writeFile(testFile, 'test content');
    setAllowedDirectories([normalizePath(testDir)]);
  });

  after(async () => {
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

  void it('setAllowedDirectories and getAllowedDirectories set and get allowed directories', () => {
    const dirs = ['/test/dir1', '/test/dir2'];
    setAllowedDirectories(dirs.map(normalizePath));
    const result = getAllowedDirectories();
    assert.strictEqual(result.length, 2);
    resetAllowedDirectories();
  });

  void it('setAllowedDirectories returns empty array when no directories set', () => {
    setAllowedDirectories([]);
    assert.deepStrictEqual(getAllowedDirectories(), []);
    resetAllowedDirectories();
  });

  void it('validateExistingPath rejects when no allowed directories configured', async () => {
    setAllowedDirectories([]);
    await assert.rejects(
      validateExistingPath(testFile),
      /no allowed directories configured/i
    );
    resetAllowedDirectories();
  });

  void it('validateExistingPath allows paths within allowed directories', async () => {
    const result = await validateExistingPath(testFile);
    assert.ok(result.includes('test.txt'));
  });

  void it('validateExistingPath allows the allowed directory itself', async () => {
    const result = await validateExistingPath(testDir);
    assert.ok(result);
  });

  void it('validateExistingPath allows subdirectories within allowed directories', async () => {
    const result = await validateExistingPath(subDir);
    assert.ok(result.includes('subdir'));
  });

  void it('validateExistingPath rejects paths outside allowed directories', async () => {
    await assert.rejects(validateExistingPath('/etc/passwd'));
  });

  void it('validateExistingPath rejects traversal attempts', async () => {
    const traversalPath = path.join(testDir, '..', 'etc', 'passwd');
    await assert.rejects(validateExistingPath(traversalPath));
  });

  void it('validateExistingPath rejects non-existent paths', async () => {
    const nonExistent = path.join(testDir, 'non-existent-file.txt');
    await assert.rejects(validateExistingPath(nonExistent));
  });

  void it('validateExistingPath allows paths when filesystem root is allowed', async () => {
    const rootDir = path.parse(testDir).root;
    setAllowedDirectories([normalizePath(rootDir)]);
    const result = await validateExistingPath(testFile);
    assert.ok(result.includes('test.txt'));
    resetAllowedDirectories();
  });

  void it('validateExistingPath handles paths with spaces', async () => {
    const fileInDir = await createFileInDir('dir with spaces', 'file.txt');
    const result = await validateExistingPath(fileInDir);
    assert.ok(result.includes('file.txt'));
    await fs.rm(path.dirname(fileInDir), { recursive: true });
  });

  void it('validateExistingPath handles paths with special characters', async () => {
    const fileInDir = await createFileInDir(
      'special-chars_123',
      'test_file-1.txt'
    );
    const result = await validateExistingPath(fileInDir);
    assert.ok(result.includes('test_file-1.txt'));
    await fs.rm(path.dirname(fileInDir), { recursive: true });
  });

  void it('validateExistingPath rejects empty path', async () => {
    await assert.rejects(validateExistingPath(''), /empty|whitespace/i);
  });

  void it('validateExistingPath rejects whitespace-only path', async () => {
    await assert.rejects(validateExistingPath('   '), /empty|whitespace/i);
  });

  void it('validateExistingPath rejects path with null bytes', async () => {
    const pathWithNull = path.join(testDir, 'file\0name.txt');
    await assert.rejects(validateExistingPath(pathWithNull));
  });

  const itWindows = process.platform === 'win32' ? it : it.skip;

  void itWindows(
    'validateExistingPath rejects Windows drive-relative paths',
    async () => {
      await assert.rejects(validateExistingPath('C:'), /drive-relative/i);
      await assert.rejects(validateExistingPath('C:temp'), /drive-relative/i);
    }
  );

  void itWindows(
    'validateExistingPath rejects Windows reserved device names with suffixes',
    async () => {
      const candidates = [
        'CON',
        'CON.txt',
        'CON.',
        'CON ',
        'CON::$DATA',
        'AUX.txt',
        'NUL ',
        'COM1',
        'LPT1.txt',
      ];

      for (const candidate of candidates) {
        const attempt = path.join(testDir, candidate);
        await assert.rejects(
          validateExistingPath(attempt),
          /reserved device name/i
        );
      }
    }
  );
});
