/**
 * Integration tests for directory-oriented tools: roots, ls, tree, mkdir, rm, mv.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { listDirectory } from '../../lib/file-operations/metadata.js';
import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
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
    const result = raw;
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
    const result = raw;
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
    assertToolError(raw, 'E_ACCESS_DENIED');
  });

  it('rejects unsafe glob patterns before traversal', async () => {
    await assert.rejects(
      () => listDirectory(env.tmpDir, { pattern: '../../*' }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'E_INVALID_PATTERN'
    );
  });

  it('paginates with an opaque cursor across multiple pages', async () => {
    for (let index = 0; index < 12; index += 1) {
      await fs.writeFile(
        path.join(env.tmpDir, `page-${String(index).padStart(2, '0')}.txt`),
        String(index),
        'utf8'
      );
    }

    const firstPage = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir, maxEntries: 5 },
    });
    assertOk(firstPage);
    const firstStructured = getStructured(firstPage);
    const firstEntries = firstStructured['entries'] as Array<
      Record<string, unknown>
    >;
    const firstCursor = firstStructured['nextCursor'];

    assert.equal(firstEntries.length, 5);
    assert.equal(typeof firstCursor, 'string');
    assert.doesNotMatch(firstCursor as string, /"offset"|"snapshotId"/u);

    const secondPage = await env.client.callTool({
      name: 'ls',
      arguments: {
        path: env.tmpDir,
        maxEntries: 5,
        cursor: firstCursor,
      },
    });
    assertOk(secondPage);
    const secondStructured = getStructured(secondPage);
    const secondEntries = secondStructured['entries'] as Array<
      Record<string, unknown>
    >;

    assert.equal(secondEntries.length, 5);
    assert.notDeepEqual(
      firstEntries.map((entry) => entry['name']),
      secondEntries.map((entry) => entry['name'])
    );
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
    const result = raw;
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
    const result = raw;
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
    const result = raw;
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
    assertOk(raw);
  });

  it('creates multiple directories via paths array', async () => {
    const d1 = path.join(env.tmpDir, 'batch-a');
    const d2 = path.join(env.tmpDir, 'batch-b');
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { paths: [d1, d2] },
    });
    assertOk(raw);
    assert.ok((await fs.stat(d1)).isDirectory());
    assert.ok((await fs.stat(d2)).isDirectory());
  });

  it('rejects creation outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { path: '/tmp/escape-' + Date.now() },
    });
    assertToolError(raw, 'E_ACCESS_DENIED');
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
    assertOk(raw);
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
    assertOk(raw);
    await assert.rejects(() => fs.stat(dir), /ENOENT/);
  });

  it('returns E_NOT_FOUND for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { path: path.join(env.tmpDir, 'ghost.txt') },
    });
    assertToolError(raw, 'E_NOT_FOUND');
  });

  it('ignoreIfNotExists suppresses E_NOT_FOUND', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: {
        path: path.join(env.tmpDir, 'definitely-not-here.txt'),
        ignoreIfNotExists: true,
      },
    });
    assertOk(raw);
  });

  it('returns E_ACCESS_DENIED when deleting workspace root', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { path: env.tmpDir, recursive: true },
    });
    assertToolError(raw, 'E_ACCESS_DENIED');
    // Verify root still exists
    const stats = await fs.stat(env.tmpDir);
    assert.ok(stats.isDirectory());
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
    assertOk(raw);
    await assert.rejects(() => fs.stat(src), /ENOENT/);
    const content = await fs.readFile(dst, 'utf8');
    assert.equal(content, 'move me');
  });

  it('returns isError for total failure when source is missing', async () => {
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: {
        source: path.join(env.tmpDir, 'no-source.txt'),
        destination: path.join(env.tmpDir, 'dst.txt'),
      },
    });
    assertToolError(raw, 'E_NOT_FOUND');
  });
});

// ─── invalid cursor ─────────────────────────────────────────────────────────

describe('invalid cursor rejection', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await fs.writeFile(path.join(env.tmpDir, 'a.txt'), 'a', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('ls rejects a malformed cursor with E_INVALID_INPUT', async () => {
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir, cursor: 'not-a-valid-cursor' },
    });
    assertToolError(raw, 'E_INVALID_INPUT');
  });

  it('find rejects a malformed cursor with E_INVALID_INPUT', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '*.txt', cursor: 'garbage!!' },
    });
    assertToolError(raw, 'E_INVALID_INPUT');
  });
});
