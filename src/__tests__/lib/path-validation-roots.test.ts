import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { normalizePath } from '../../lib/path-utils.js';
import { getValidRootDirectories } from '../../lib/path-validation/roots.js';

function toRoot(uri: string): Root {
  return { uri };
}

function registerRootDirectoryTests(
  getTestDir: () => string,
  getTestFile: () => string
): void {
  void it('getValidRootDirectories returns only file roots that are directories', async () => {
    const roots = [
      toRoot(pathToFileURL(getTestDir()).toString()),
      toRoot(pathToFileURL(getTestFile()).toString()),
      toRoot('http://example.com'),
    ];

    const result = await getValidRootDirectories(roots);

    assert.deepStrictEqual(result, [normalizePath(getTestDir())]);
  });
}

function registerRootDirectoryMissingTests(getTestDir: () => string): void {
  void it('getValidRootDirectories ignores invalid root directories', async () => {
    const missing = path.join(getTestDir(), 'missing');
    const roots = [toRoot(pathToFileURL(missing).toString())];

    const result = await getValidRootDirectories(roots);

    assert.deepStrictEqual(result, []);
  });
}

void describe('getValidRootDirectories', () => {
  let testDir = '';
  let testFile = '';

  before(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-roots-'));
    testFile = path.join(testDir, 'test.txt');
    await fs.writeFile(testFile, 'data');
  });

  after(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  registerRootDirectoryTests(
    () => testDir,
    () => testFile
  );
  registerRootDirectoryMissingTests(() => testDir);
});
