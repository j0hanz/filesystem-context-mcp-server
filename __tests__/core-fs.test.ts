import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import { normalizePath } from '../src/core/path.js';
import { searchContent, searchFiles } from '../src/core/search.js';
import type { FilesystemServerContext } from '../src/server.js';
import {
  cleanupTestRoot,
  createTestRoot,
  createTestServer,
  writeNLineFile,
  writeTestFile,
} from './helpers.js';

describe('Core Filesystem (GuardedFileSystem + core search) Tests', () => {
  let tmpDir: string;
  let ctx: FilesystemServerContext;

  before(async () => {
    tmpDir = await createTestRoot();
    ctx = await createTestServer([tmpDir]);
  });

  after(async () => {
    if (ctx) {
      await ctx.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  describe('Read slicing & batch (TC-FUNC-002–006)', () => {
    it('TC-FUNC-002: readFile with head slicing returns first N lines', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_head.txt', 10);
      const result = await ctx.fs.readFile(filePath, { kind: 'head', lines: 5 });

      assert.strictEqual(result.readMode, 'head');
      assert.strictEqual(result.head, 5);
      assert.strictEqual(result.linesRead, 5);
      assert.strictEqual(result.truncated, true);
      assert.strictEqual(result.hasMoreLines, true);
      assert.strictEqual(result.content, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    });

    it('TC-FUNC-003: readFile with tail slicing returns last N lines', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_tail.txt', 10);
      const result = await ctx.fs.readFile(filePath, { kind: 'tail', lines: 3 });

      assert.strictEqual(result.readMode, 'tail');
      assert.strictEqual(result.tail, 3);
      assert.strictEqual(result.linesRead, 3);
      assert.strictEqual(result.content, 'Line 8\nLine 9\nLine 10');
    });

    it('TC-FUNC-004: readFile with line range returns specific lines', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_range.txt', 10);
      const result = await ctx.fs.readFile(filePath, {
        kind: 'range',
        start: 2,
        end: 4,
      });

      assert.strictEqual(result.readMode, 'range');
      assert.strictEqual(result.startLine, 2);
      assert.strictEqual(result.endLine, 4);
      assert.strictEqual(result.linesRead, 3);
      assert.strictEqual(result.content, 'Line 2\nLine 3\nLine 4');
    });

    it('TC-FUNC-005: readFile with byte range returns byte slice', async () => {
      const filePath = await writeTestFile(tmpDir, 'read_bytes.txt', '0123456789ABCDEF');
      const result = await ctx.fs.readFile(filePath, {
        kind: 'byteRange',
        offset: 6,
        length: 5,
      });

      assert.strictEqual(result.readMode, 'byteRange');
      assert.strictEqual(result.offset, 6);
      assert.strictEqual(result.bytesRead, 5);
      assert.strictEqual(result.content, '6789A');
    });

    it('TC-FUNC-006: readFile full returns entire content and line count', async () => {
      const filePath = await writeNLineFile(tmpDir, 'read_full.txt', 5);
      const result = await ctx.fs.readFile(filePath, { kind: 'full' });

      assert.strictEqual(result.readMode, 'full');
      assert.strictEqual(result.totalLines, 5);
      assert.strictEqual(result.truncated, false);
      assert.strictEqual(result.hasMoreLines, false);
      assert.strictEqual(result.content, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
    });
  });

  describe('Editable text loading', () => {
    it('readEditableText returns validated path, content, and stats', async () => {
      const filePath = await writeTestFile(tmpDir, 'editable.txt', 'editable content');

      const result = await ctx.fs.readEditableText(filePath);

      assert.strictEqual(result.validPath, normalizePath(filePath));
      assert.strictEqual(result.content, 'editable content');
      assert.strictEqual(result.stats.size, Buffer.byteLength('editable content'));
    });

    it('readEditableText rejects files above the configured text limit', async () => {
      const previous = process.env['MAX_FILE_SIZE'];
      const limit = 1024 * 1024;
      process.env['MAX_FILE_SIZE'] = String(limit);
      try {
        const filePath = join(tmpDir, 'too-large.txt');
        await writeFile(filePath, Buffer.alloc(limit + 1, 0x61));

        await assert.rejects(
          ctx.fs.readEditableText(filePath),
          (error) =>
            isFsError(error) &&
            error.code === ErrorCode.TOO_LARGE &&
            error.message.includes('File too large for edit'),
        );
      } finally {
        if (previous === undefined) delete process.env['MAX_FILE_SIZE'];
        else process.env['MAX_FILE_SIZE'] = previous;
      }
    });

    it('readEditableText rejects binary files', async () => {
      const filePath = join(tmpDir, 'editable.png');
      await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

      await assert.rejects(
        ctx.fs.readEditableText(filePath),
        (error) =>
          isFsError(error) &&
          error.code === ErrorCode.INVALID_INPUT &&
          error.message === 'Binary file detected.',
      );
    });
  });

  describe('Create nested & overwrite (TC-FUNC-010–011)', () => {
    it('TC-FUNC-010: writeFile in deep nested path after creating parent directories', async () => {
      const nestedPath = join(tmpDir, 'deep', 'nested', 'subfolder', 'file.txt');
      await ctx.fs.mkdir(dirname(nestedPath), { recursive: true });
      await ctx.fs.writeFile(nestedPath, 'deep nested content');

      const { content } = await ctx.fs.readRaw(nestedPath);
      assert.strictEqual(content.toString('utf-8'), 'deep nested content');
    });

    it('TC-FUNC-011: writeFile overwriting existing file', async () => {
      const filePath = join(tmpDir, 'overwrite_target.txt');
      await ctx.fs.writeFile(filePath, 'initial content');

      const initialRead = await ctx.fs.readRaw(filePath);
      assert.strictEqual(initialRead.content.toString('utf-8'), 'initial content');

      await ctx.fs.writeFile(filePath, 'overwritten content');

      const overwrittenRead = await ctx.fs.readRaw(filePath);
      assert.strictEqual(overwrittenRead.content.toString('utf-8'), 'overwritten content');
    });
  });

  describe('Stat metadata (TC-FUNC-031–034)', () => {
    it('TC-FUNC-031: statDetailed on a file returns stats and isSymlink=false', async () => {
      const filePath = await writeTestFile(tmpDir, 'stat_file.txt', 'stat metadata test');
      const detail = await ctx.fs.statDetailed(filePath);

      assert.strictEqual(detail.isSymlink, false);
      assert.strictEqual(detail.stats.isFile(), true);
      assert.strictEqual(detail.stats.isDirectory(), false);
      assert.strictEqual(detail.stats.size, Buffer.byteLength('stat metadata test'));
    });

    it('TC-FUNC-032: statDetailed on a dir returns stats.isDirectory()=true', async () => {
      const dirPath = join(tmpDir, 'stat_test_directory');
      await ctx.fs.mkdir(dirPath);

      const detail = await ctx.fs.statDetailed(dirPath);

      assert.strictEqual(detail.isSymlink, false);
      assert.strictEqual(detail.stats.isDirectory(), true);
      assert.strictEqual(detail.stats.isFile(), false);
    });

    it('lstat propagates an already-aborted signal', async () => {
      const filePath = await writeTestFile(tmpDir, 'aborted-lstat.txt', 'content');
      const reason = new Error('lstat aborted');
      const controller = new AbortController();
      controller.abort(reason);

      await assert.rejects(ctx.fs.lstat(filePath, { signal: controller.signal }), (error) => {
        assert.strictEqual(error, reason);
        return true;
      });
    });
  });

  describe('Hashing (TC-FUNC-035–038)', () => {
    it('TC-FUNC-035: hash returns 64-char sha256 hex string matching content', async () => {
      const content = 'Hashing test content for sha256 verification\n';
      const filePath = await writeTestFile(tmpDir, 'hash_test.txt', content);

      const expectedHash = createHash('sha256').update(content).digest('hex');
      const actualHash = await ctx.fs.hash(filePath);

      assert.strictEqual(actualHash.length, 64);
      assert.match(actualHash, /^[0-9a-f]{64}$/);
      assert.strictEqual(actualHash, expectedHash);
    });
  });

  describe('Search & Glob (TC-FUNC-039–046)', () => {
    it('TC-FUNC-039: searchFiles with pattern matching filters files', async () => {
      await writeTestFile(tmpDir, 'search_dir/moduleA.ts', 'export const a = 1;');
      await writeTestFile(tmpDir, 'search_dir/moduleB.ts', 'export const b = 2;');
      await writeTestFile(tmpDir, 'search_dir/notes.txt', 'some notes');
      await writeTestFile(tmpDir, 'search_dir/sub/moduleC.ts', 'export const c = 3;');
      await writeTestFile(tmpDir, 'search_dir/sub/readme.txt', 'readme doc');

      const searchDir = join(tmpDir, 'search_dir');

      const tsResults = await searchFiles(searchDir, '**/*.ts', [], {}, ctx.pathGuard);
      assert.strictEqual(tsResults.results.length, 3);
      assert.ok(tsResults.results.every((r) => r.path.endsWith('.ts')));

      const txtResults = await searchFiles(searchDir, '**/*.txt', [], {}, ctx.pathGuard);
      assert.strictEqual(txtResults.results.length, 2);
      assert.ok(txtResults.results.every((r) => r.path.endsWith('.txt')));
    });

    it('TC-FUNC-040: searchContent matches literal patterns across files', async () => {
      const searchContentDir = join(tmpDir, 'search_content_dir');
      await writeTestFile(
        searchContentDir,
        'file1.txt',
        'First line\nTARGET_LITERAL_STRING in file1\nThird line',
      );
      await writeTestFile(searchContentDir, 'file2.txt', 'No match here\nStill nothing');
      await writeTestFile(
        searchContentDir,
        'file3.txt',
        'TARGET_LITERAL_STRING at line 1\nAnother TARGET_LITERAL_STRING line',
      );

      const outcome = await searchContent(
        searchContentDir,
        'TARGET_LITERAL_STRING',
        { isRegex: false },
        ctx.pathGuard,
      );

      assert.strictEqual(outcome.summary.filesMatched, 2);
      assert.strictEqual(outcome.summary.matchingLines, 3);
      assert.strictEqual(outcome.matches.length, 3);
      assert.ok(outcome.matches.every((m) => m.content.includes('TARGET_LITERAL_STRING')));
    });
  });

  describe('Delete guards (TC-FUNC-018–020)', () => {
    it('TC-FUNC-018: hasChildrenUnchecked distinguishes empty vs non-empty directories', async () => {
      const emptyDir = join(tmpDir, 'empty_dir_guard');
      await ctx.fs.mkdir(emptyDir);

      const emptyHasChildren = await ctx.fs.hasChildrenUnchecked(emptyDir);
      assert.strictEqual(emptyHasChildren, false);

      const nonEmptyDir = join(tmpDir, 'non_empty_dir_guard');
      await ctx.fs.mkdir(nonEmptyDir);
      await writeTestFile(nonEmptyDir, 'child.txt', 'child content');

      const nonEmptyHasChildren = await ctx.fs.hasChildrenUnchecked(nonEmptyDir);
      assert.strictEqual(nonEmptyHasChildren, true);
    });

    it('TC-FUNC-019: rm with recursive=true removes non-empty directory', async () => {
      const dirToDelete = join(tmpDir, 'dir_to_delete');
      await ctx.fs.mkdir(dirToDelete);
      await writeTestFile(dirToDelete, 'file1.txt', 'f1');
      await writeTestFile(dirToDelete, 'sub/file2.txt', 'f2');

      await ctx.fs.rm(dirToDelete, { recursive: true, force: true });

      await assert.rejects(
        () => ctx.fs.stat(dirToDelete),
        (err: unknown) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
          return true;
        },
      );
    });
  });
});
