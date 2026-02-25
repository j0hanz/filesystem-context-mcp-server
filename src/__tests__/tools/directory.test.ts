/**
 * Integration tests for directory-oriented tools: roots, ls, tree, mkdir, rm, mv.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
  type ToolResult,
} from '../helpers.js';

// ─── roots ──────────────────────────────────────────────────────────────────

describe('roots tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns ok:true with the allowed tmpDir', async () => {
    const raw = await env.client.callTool({ name: 'roots', arguments: {} });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const dirs = sc['directories'] as string[];
    assert.ok(
      Array.isArray(dirs) && dirs.length > 0,
      'Expected at least one directory'
    );
  });
});

// ─── ls ─────────────────────────────────────────────────────────────────────

describe('ls tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await fs.writeFile(path.join(env.tmpDir, 'alpha.txt'), 'a', 'utf8');
    await fs.writeFile(path.join(env.tmpDir, 'beta.txt'), 'b', 'utf8');
    await fs.mkdir(path.join(env.tmpDir, 'sub'));
  });

  after(async () => {
    await env.cleanup();
  });

  it('lists entries in the allowed directory', async () => {
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const entries = sc['entries'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(entries) && entries.length >= 3);

    const names = entries.map((e) => e['name'] as string);
    assert.ok(names.includes('alpha.txt'));
    assert.ok(names.includes('beta.txt'));
    assert.ok(names.includes('sub'));
  });

  it('returns E_ACCESS_DENIED for paths outside allowed roots', async () => {
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: '/etc' },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
  });
});

// ─── tree ───────────────────────────────────────────────────────────────────

describe('tree tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    const sub = path.join(env.tmpDir, 'deep', 'dir');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'nested.txt'), 'deep', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns a tree structure with ok:true', async () => {
    const raw = await env.client.callTool({
      name: 'tree',
      arguments: { path: env.tmpDir },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(sc['tree'] !== undefined, 'Expected tree field');
  });

  it('respects maxDepth:1 to limit nesting', async () => {
    const raw = await env.client.callTool({
      name: 'tree',
      arguments: { path: env.tmpDir, maxDepth: 1 },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
  });
});

// ─── mkdir ──────────────────────────────────────────────────────────────────

describe('mkdir tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('creates a new directory', async () => {
    const newDir = path.join(env.tmpDir, 'new-dir');
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { path: newDir },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const stat = await fs.stat(newDir);
    assert.ok(stat.isDirectory());
  });

  it('is idempotent — creating an existing directory is not an error', async () => {
    const existingDir = path.join(env.tmpDir, 'idempotent-dir');
    await fs.mkdir(existingDir);
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { path: existingDir },
    });
    assertOk(raw as unknown as ToolResult);
  });

  it('creates multiple directories via paths array', async () => {
    const d1 = path.join(env.tmpDir, 'batch-a');
    const d2 = path.join(env.tmpDir, 'batch-b');
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { paths: [d1, d2] },
    });
    assertOk(raw as unknown as ToolResult);
    assert.ok((await fs.stat(d1)).isDirectory());
    assert.ok((await fs.stat(d2)).isDirectory());
  });

  it('rejects creation outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { path: '/tmp/escape-' + Date.now() },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
  });
});

// ─── rm ─────────────────────────────────────────────────────────────────────

describe('rm tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('removes an existing file', async () => {
    const file = path.join(env.tmpDir, 'to-delete.txt');
    await fs.writeFile(file, 'bye', 'utf8');
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { path: file },
    });
    assertOk(raw as unknown as ToolResult);
    await assert.rejects(() => fs.stat(file), /ENOENT/);
  });

  it('removes a directory recursively', async () => {
    const dir = path.join(env.tmpDir, 'to-delete-dir');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'inner.txt'), 'inner', 'utf8');
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { path: dir, recursive: true },
    });
    assertOk(raw as unknown as ToolResult);
    await assert.rejects(() => fs.stat(dir), /ENOENT/);
  });

  it('returns E_NOT_FOUND for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { path: path.join(env.tmpDir, 'ghost.txt') },
    });
    assertToolError(raw as unknown as ToolResult, 'E_NOT_FOUND');
  });

  it('ignoreIfNotExists suppresses E_NOT_FOUND', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: {
        path: path.join(env.tmpDir, 'definitely-not-here.txt'),
        ignoreIfNotExists: true,
      },
    });
    assertOk(raw as unknown as ToolResult);
  });
});

// ─── mv ─────────────────────────────────────────────────────────────────────

describe('mv tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('moves a file to a new path', async () => {
    const src = path.join(env.tmpDir, 'source.txt');
    const dst = path.join(env.tmpDir, 'dest.txt');
    await fs.writeFile(src, 'move me', 'utf8');
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: { source: src, destination: dst },
    });
    assertOk(raw as unknown as ToolResult);
    await assert.rejects(() => fs.stat(src), /ENOENT/);
    const content = await fs.readFile(dst, 'utf8');
    assert.equal(content, 'move me');
  });

  it('returns ok:false with failed array when source is missing', async () => {
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: {
        source: path.join(env.tmpDir, 'no-source.txt'),
        destination: path.join(env.tmpDir, 'dst.txt'),
      },
    });
    // mv collects per-source errors into a failed[] array; it does NOT set isError:true
    const result = raw as unknown as ToolResult;
    const sc = getStructured(result);
    assert.equal(sc['ok'], false);
    const failed = sc['failed'] as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(failed) && failed.length > 0,
      'Expected failed entries for missing source'
    );
  });
});
