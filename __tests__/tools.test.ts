import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, FsError } from '../src/core/errors.js';
import { MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.js';
import { cleanupTestRoot, createTestRoot, createTestServer } from './helpers.js';

describe('P0 Functional Tests - Tools', () => {
  let tmpDir: string;
  let ctx: Awaited<ReturnType<typeof createTestServer>>;

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

  it('TC-FUNC-001: Read single text file', async () => {
    const file = join(tmpDir, 'hello.txt');
    await writeFile(file, 'Hello\nWorld\n');

    const result = await ctx.fs.readRaw(file);
    assert.strictEqual(result.content.toString('utf-8'), 'Hello\nWorld\n');
    assert.strictEqual(result.isBinary, false);
  });

  it('TC-FUNC-007: Read path outside allowed root', async () => {
    const outsideFile = join(tmpdir(), 'outside_test.txt');
    await writeFile(outsideFile, 'secret');
    try {
      await assert.rejects(
        () => ctx.fs.readRaw(outsideFile),
        (err: Error) => {
          assert(err instanceof FsError);
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
      );
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('TC-FUNC-009: Create single file', async () => {
    const file = join(tmpDir, 'new.txt');
    await ctx.fs.writeFile(file, 'new content');

    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'new content');
  });

  it('TC-FUNC-012: --read-only suppresses mutating tools', () => {
    const readOnlyTools = registeredTools(true);
    assert.strictEqual(readOnlyTools.length, 7);
    for (const tool of readOnlyTools) {
      assert(!MUTATING_TOOL_NAMES.has(tool.name));
    }

    const allTools = registeredTools(false);
    assert.strictEqual(allTools.length, 12);
  });

  it('TC-FUNC-013: Edit via GuardedFileSystem', async () => {
    const file = join(tmpDir, 'edit.txt');
    await writeFile(file, 'original content');

    const readRes = await ctx.fs.readRaw(file);
    assert.strictEqual(readRes.content.toString('utf-8'), 'original content');

    await ctx.fs.writeFile(file, 'modified content');

    const readRes2 = await ctx.fs.readRaw(file);
    assert.strictEqual(readRes2.content.toString('utf-8'), 'modified content');
  });

  it('TC-FUNC-015: Read non-existent file', async () => {
    const missing = join(tmpDir, 'missing.txt');
    await assert.rejects(
      () => ctx.fs.readRaw(missing),
      (err: Error) => {
        assert(err instanceof FsError);
        assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
        return true;
      },
    );
  });

  it('TC-FUNC-017: Delete file via GuardedFileSystem', async () => {
    const file = join(tmpDir, 'delete.txt');
    await writeFile(file, 'to delete');

    await ctx.fs.rm(file);

    await assert.rejects(
      () => ctx.fs.readRaw(file),
      (err: Error) => {
        assert(err instanceof FsError);
        assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
        return true;
      },
    );
  });

  it('TC-FUNC-021: Move/rename via GuardedFileSystem', async () => {
    const file = join(tmpDir, 'old.txt');
    const newFile = join(tmpDir, 'new_name.txt');
    await writeFile(file, 'move me');

    await ctx.fs.rename(file, newFile);

    await assert.rejects(
      () => ctx.fs.readRaw(file),
      (err: Error) => {
        assert(err instanceof FsError);
        assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
        return true;
      },
    );

    const result = await ctx.fs.readRaw(newFile);
    assert.strictEqual(result.content.toString('utf-8'), 'move me');
  });

  it('TC-FUNC-052: List roots', async () => {
    const dirs = ctx.pathGuard.getAllowedDirectories();
    assert(dirs.length > 0, 'Should have at least one allowed directory');
  });
});
