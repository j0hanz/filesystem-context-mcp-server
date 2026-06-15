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

  // Regression: zero-width regex patterns (a*, a?, x*) must not infinite-loop
  it('should terminate when regex can produce zero-width matches', async () => {
    const tempDir = join(tmpdir(), `test-search-engine-zerowidth-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    try {
      const filePath = join(tempDir, 'data.txt');
      await writeFile(filePath, 'baaa\nbb\nhello\n', 'utf8');

      const guard = await PathGuard.fromAllowedDirectories([tempDir]);
      const fs = new GuardedFileSystem(guard);

      // "a*" matches zero-width at every position not preceded by 'a' — must not hang
      const r1 = await executeSearch(fs, { pattern: 'a*', path: filePath });
      assert.ok(r1.summary.filesMatched >= 0, 'a* search should complete');

      // "a?" also zero-width capable
      const r2 = await executeSearch(fs, { pattern: 'a?', path: filePath });
      assert.ok(r2.summary.filesMatched >= 0, 'a? search should complete');

      // "x*" always zero-width on text with no 'x'
      const r3 = await executeSearch(fs, { pattern: 'x*', path: filePath });
      assert.ok(r3.summary.filesMatched >= 0, 'x* search should complete');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should match whole-word containing punctuation', async () => {
    const tempDir = join(tmpdir(), `test-search-engine-wholeword-punc-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    try {
      const filePath = join(tempDir, 'data.txt');
      await writeFile(filePath, 'hello foo!\nbar\n', 'utf8');

      const guard = await PathGuard.fromAllowedDirectories([tempDir]);
      const fs = new GuardedFileSystem(guard);

      const result = await executeSearch(fs, {
        pattern: 'foo!',
        path: filePath,
        wholeWord: true,
        isLiteral: true,
      });

      assert.equal(result.summary.filesMatched, 1);
      assert.equal(result.filesMatched.length, 1);
      assert.equal(result.filesMatched[0].matches[0].content, 'hello foo!');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should respect maxResults in file-only search', async () => {
    const tempDir = join(tmpdir(), `test-search-engine-file-only-limit-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    try {
      await writeFile(join(tempDir, 'a.txt'), 'content', 'utf8');
      await writeFile(join(tempDir, 'b.txt'), 'content', 'utf8');
      await writeFile(join(tempDir, 'c.txt'), 'content', 'utf8');

      const guard = await PathGuard.fromAllowedDirectories([tempDir]);
      const fs = new GuardedFileSystem(guard);

      const result = await executeSearch(fs, {
        path: tempDir,
        fileSearch: true,
        maxResults: 2,
      });

      assert.equal(result.filesMatched.length, 2);
      assert.equal(result.summary.filesMatched, 2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
