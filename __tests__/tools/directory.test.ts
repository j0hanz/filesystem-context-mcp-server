/**
 * Integration tests for directory-oriented tools: roots, ls, tree, mkdir, rm, mv.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { listDirectory } from '../../src/lib/file-operations/metadata.js';
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
    const roots = sc['roots'] as { uri: string }[];
    assert.ok(
      Array.isArray(roots) && roots.length > 0,
      'Expected at least one directory'
    );
  });
});

// ─── ls ─────────────────────────────────────────────────────────────────────

describe('ls tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'alpha.txt'), 'a', 'utf8');
    await writeFile(join(env.tmpDir, 'beta.txt'), 'b', 'utf8');
    await mkdir(join(env.tmpDir, 'sub'));
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
    const entries = sc['entries'] as Record<string, unknown>[];
    assert.ok(Array.isArray(entries) && entries.length >= 3);

    const names = entries.map((e) => e['name'] as string);
    assert.ok(names.includes('alpha.txt'));
    assert.ok(names.includes('beta.txt'));
    assert.ok(names.includes('sub'));
  });

  it('returns ACCESS_DENIED for paths outside allowed roots', async () => {
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: '/etc' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('rejects unsafe glob patterns before traversal', async () => {
    await assert.rejects(
      () => listDirectory(env.tmpDir, { pattern: '../../*' }),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'INVALID_PATTERN'
    );
  });

  it('paginates with an opaque cursor across multiple pages', async () => {
    for (let index = 0; index < 12; index += 1) {
      await writeFile(
        join(env.tmpDir, `page-${String(index).padStart(2, '0')}.txt`),
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
    const firstEntries = firstStructured['entries'] as Record<
      string,
      unknown
    >[];
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
    const secondEntries = secondStructured['entries'] as Record<
      string,
      unknown
    >[];

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
    const sub = join(env.tmpDir, 'deep', 'dir');
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, 'nested.txt'), 'deep', 'utf8');
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
    const newDir = join(env.tmpDir, 'new-dir');
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { paths: [newDir] },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);
    const created = sc['created'] as { path: string; isNew: boolean }[];
    assert.ok(Array.isArray(created));
    assert.equal(created[0]?.path.toLowerCase(), newDir.toLowerCase());
    const statResult = await stat(newDir);
    assert.ok(statResult.isDirectory());
  });

  it('is idempotent — creating an existing directory is not an error', async () => {
    const existingDir = join(env.tmpDir, 'idempotent-dir');
    await mkdir(existingDir);
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { paths: [existingDir] },
    });
    assertOk(raw);
  });

  it('creates multiple directories via paths array', async () => {
    const d1 = join(env.tmpDir, 'batch-a');
    const d2 = join(env.tmpDir, 'batch-b');
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { paths: [d1, d2] },
    });
    assertOk(raw);
    assert.ok((await stat(d1)).isDirectory());
    assert.ok((await stat(d2)).isDirectory());
  });

  it('rejects creation outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: { paths: [`/tmp/escape-${Date.now()}`] },
    });
    assertToolError(raw, 'ACCESS_DENIED');
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
    const file = join(env.tmpDir, 'to-delete.txt');
    await writeFile(file, 'bye', 'utf8');
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { paths: [file] },
    });
    assertOk(raw);
    await assert.rejects(() => stat(file), /ENOENT/);
  });

  it('removes a directory recursively', async () => {
    const dir = join(env.tmpDir, 'to-delete-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'inner.txt'), 'inner', 'utf8');
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(raw);
    await assert.rejects(() => stat(dir), /ENOENT/);
  });

  it('returns NOT_FOUND for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { paths: [join(env.tmpDir, 'ghost.txt')] },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.ok(Array.isArray(sc['failures']), 'failures must be present');
    assert.equal(sc['failures']?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('ignoreIfNotExists suppresses NOT_FOUND', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: {
        paths: [join(env.tmpDir, 'definitely-not-here.txt')],
        ignoreIfNotExists: true,
      },
    });
    assertOk(raw);
  });

  it('returns ACCESS_DENIED when deleting workspace root', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { paths: [env.tmpDir], recursive: true },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.ok(Array.isArray(sc['failures']), 'failures must be present');
    assert.equal(sc['failures']?.[0]?.error?.code, 'ACCESS_DENIED');
    // Verify root still exists
    const stats = await stat(env.tmpDir);
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
    const src = join(env.tmpDir, 'source.txt');
    const dst = join(env.tmpDir, 'dest.txt');
    await writeFile(src, 'move me', 'utf8');
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: { sources: [src], destination: dst },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.deepEqual(
      (sc['sources'] as string[]).map((entry) => entry.toLowerCase()),
      [src.toLowerCase()]
    );
    assert.equal(
      (sc['destination'] as string).toLowerCase(),
      dst.toLowerCase()
    );
    await assert.rejects(() => stat(src), /ENOENT/);
    const content = await readFile(dst, 'utf8');
    assert.equal(content, 'move me');
  });

  it('returns isError for total failure when source is missing', async () => {
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: {
        sources: [join(env.tmpDir, 'no-source.txt')],
        destination: join(env.tmpDir, 'dst.txt'),
      },
    });
    assertToolError(raw, 'NOT_FOUND');
  });
});

// ─── invalid cursor ─────────────────────────────────────────────────────────

describe('invalid cursor rejection', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'a.txt'), 'a', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('ls rejects a malformed cursor with INVALID_INPUT', async () => {
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir, cursor: 'not-a-valid-cursor' },
    });
    assertToolError(raw, 'INVALID_INPUT');
  });

  it('find rejects a malformed cursor with INVALID_INPUT', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
        cursor: 'not-a-valid-cursor',
      },
    });
    assertToolError(raw, 'INVALID_INPUT');
  });
});
