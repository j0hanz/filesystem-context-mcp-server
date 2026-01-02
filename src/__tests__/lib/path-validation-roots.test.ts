import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { normalizePath } from '../../lib/path-utils.js';
import { getValidRootDirectories } from '../../lib/path-validation.js';

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

  function toRoot(uri: string): Root {
    const root: Root = { uri };
    return root;
  }

  void it('getValidRootDirectories returns only file roots that are directories', async () => {
    const roots = [
      toRoot(pathToFileURL(testDir).toString()),
      toRoot(pathToFileURL(testFile).toString()),
      toRoot('http://example.com'),
    ];

    const result = await getValidRootDirectories(roots);

    assert.deepStrictEqual(result, [normalizePath(testDir)]);
  });

  void it('getValidRootDirectories ignores invalid root directories', async () => {
    const missing = path.join(testDir, 'missing');
    const roots = [toRoot(pathToFileURL(missing).toString())];

    const result = await getValidRootDirectories(roots);

    assert.deepStrictEqual(result, []);
  });
});
