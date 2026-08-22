import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import { normalizePath } from '../src/core/path.js';
import { ALL_REGISTERED_TOOL_NAMES, ALL_TOOLS } from '../src/tools/index.js';
import { cleanupTestRoot, createTestRoot, createTestServer, writeTestFile } from './helpers.js';

describe('Smoke Tests', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  it('SMOKE-001: Server starts (stdio context)', async () => {
    const ctx = await createTestServer([tmpDir]);
    assert.ok(ctx.mcp, 'ctx.mcp should be defined');
    assert.ok(ctx.pathGuard, 'ctx.pathGuard should be defined');
    assert.ok(ctx.fs, 'ctx.fs should be defined');
    await ctx.close();
  });

  it('SMOKE-003: tools/list returns 12 tools', () => {
    assert.strictEqual(ALL_TOOLS.length, 12);
    assert.deepStrictEqual(
      ALL_TOOLS.map((t) => t.name).sort(),
      [...ALL_REGISTERED_TOOL_NAMES].sort(),
    );
  });

  it('SMOKE-004: list_roots returns allowed dirs', async () => {
    const ctx = await createTestServer([tmpDir]);
    const allowedDirs = ctx.pathGuard.getAllowedDirectories();

    const normalizedTmpDir = normalizePath(tmpDir);
    const hasDir = allowedDirs.some((d) => normalizePath(d) === normalizedTmpDir);
    assert.ok(hasDir, 'tmpDir should be in allowed directories');

    await ctx.close();
  });

  it('SMOKE-005: read returns file content', async () => {
    const ctx = await createTestServer([tmpDir]);
    const filePath = await writeTestFile(tmpDir, 'test.txt', 'Hello, MCP!');
    const { content, isBinary } = await ctx.fs.readRaw(filePath);
    assert.equal(isBinary, false);
    assert.equal(content.toString('utf-8'), 'Hello, MCP!');
    await ctx.close();
  });

  it('SMOKE-006: Path traversal blocked', async () => {
    const ctx = await createTestServer([tmpDir]);
    const badPath = join(tmpDir, '../../../etc/passwd');
    await assert.rejects(
      async () => {
        await ctx.fs.pathGuard.validateExistingPath(badPath);
      },
      (err: unknown) => {
        if (isFsError(err)) {
          return err.code === ErrorCode.ACCESS_DENIED || err.code === ErrorCode.NOT_FOUND;
        }
        return false;
      },
      'Should throw ACCESS_DENIED or NOT_FOUND FsError',
    );
    await ctx.close();
  });
});
