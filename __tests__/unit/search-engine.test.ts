import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { GuardedFileSystem } from '../../src/core/fs.js';
import { PathGuard } from '../../src/core/path.js';
import { executeSearch } from '../../src/core/search/engine.js';

describe('search engine matching', () => {
  it('should find matching lines in a file', async () => {
    const tempDir = join(tmpdir(), `test-search-engine-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    try {
      const filePath = join(tempDir, 'fruits.txt');
      await writeFile(filePath, 'apple\nbanana\ncherry\n', 'utf8');

      const guard = await PathGuard.fromAllowedDirectories([tempDir]);
      const fs = new GuardedFileSystem(guard);

      const result = await executeSearch(fs, {
        pattern: 'banana',
        path: tempDir,
      });

      assert.equal(result.summary.filesMatched, 1);
      assert.equal(result.filesMatched.length, 1);
      assert.equal(result.filesMatched[0].filePath.toLowerCase(), filePath.toLowerCase());
      assert.equal(result.filesMatched[0].matches.length, 1);
      assert.equal(result.filesMatched[0].matches[0].content, 'banana');
      assert.equal(result.filesMatched[0].matches[0].line, 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
