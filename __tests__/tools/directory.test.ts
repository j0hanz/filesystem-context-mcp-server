/**
 * Integration tests for directory-oriented tools: roots, ls, tree, mkdir, rm, mv.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

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

  it('lists allowed roots with terse summary', async () => {
    const raw = await env.client.callTool({ name: 'list_roots', arguments: {} });
    const result = raw;
    assertOk(result);

    // Verify content: terse summary, no resource links
    assert.equal(result.content.length, 1, 'Expected exactly one content block');
    assert.equal(result.content[0].type, 'text', 'Expected text content');
    const summaryText = result.content[0].text;
    assert.ok(summaryText.startsWith('roots:'), 'Expected summary to start with "roots:"');
    assert.ok(summaryText.includes('allowed'), 'Expected summary to include "allowed"');

    // Verify structured content
    const sc = getStructured(result);
    const roots = sc['roots'] as string[];
    assert.ok(
      Array.isArray(roots) && roots.length > 0,
      'Expected at least one root directory path',
    );
    assert.ok(
      roots.every((r) => typeof r === 'string'),
      'Expected all roots to be strings',
    );
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe('list tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'alpha.txt'), 'a', 'utf8');
    await writeFile(join(env.tmpDir, 'beta.txt'), 'b', 'utf8');
    await mkdir(join(env.tmpDir, 'sub'));
    await writeFile(join(env.tmpDir, 'sub', 'nested.txt'), 'n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('lists top-level entries flat (default maxDepth=1)', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);
    assert.equal(typeof sc['path'], 'string');
    assert.equal(typeof sc['markdown'], 'string');

    const entries = sc['entries'] as Record<string, unknown>[];
    const names = entries.map((e) => e['name'] as string);

    // sub directory, then alpha.txt, beta.txt (dirs-first, alpha)
    assert.ok(names.includes('sub'), 'Expected sub dir');
    assert.ok(names.includes('alpha.txt'), 'Expected alpha.txt');
    assert.ok(names.includes('beta.txt'), 'Expected beta.txt');

    // dirs-first: sub must appear before alpha.txt
    assert.ok(names.indexOf('sub') < names.indexOf('alpha.txt'), 'Expected dirs first');

    // flat: nested.txt must NOT appear at maxDepth=1
    assert.ok(!names.includes('nested.txt'), 'Expected no nested entries at maxDepth=1');

    assert.ok(typeof sc['entryCount'] === 'number');
    assert.ok(typeof sc['totalEntries'] === 'number');
    assert.ok(typeof sc['totalFiles'] === 'number');
    assert.ok(typeof sc['totalDirectories'] === 'number');
    assert.equal(sc['totalDirectories'], 1);
  });

  it('recurses when maxDepth > 1', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir, maxDepth: 2 },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    const entries = sc['entries'] as Record<string, unknown>[];
    const names = entries.map((e) => e['name'] as string);

    assert.ok(names.includes('nested.txt'), 'Expected nested.txt at maxDepth=2');

    // relativePath must be POSIX
    const nested = entries.find((e) => e['name'] === 'nested.txt');
    assert.ok(nested);
    assert.equal(nested['relativePath'], 'sub/nested.txt');
  });

  it('markdown contains root name and entry names', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    const markdown = sc['markdown'] as string;
    const lines = markdown.split('\n');

    // First line is the root dir name
    assert.ok(lines[0] !== undefined && lines[0].length > 0, 'Expected root name as first line');
    assert.ok(markdown.includes('sub'), 'Expected sub in markdown');
    assert.ok(markdown.includes('alpha.txt'), 'Expected alpha.txt in markdown');
    // Box-drawing chars present
    assert.ok(markdown.includes('├──') || markdown.includes('└──'), 'Expected box-drawing chars');
  });

  it('truncation stores full result in resourceUri', async () => {
    const manyDir = join(env.tmpDir, 'many');
    await mkdir(manyDir);
    for (let i = 0; i < 10; i++) {
      await writeFile(join(manyDir, `f${String(i).padStart(2, '0')}.txt`), '', 'utf8');
    }

    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: manyDir, maxEntries: 3 },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    assert.equal(sc['entryCount'], 3);
    assert.ok((sc['totalEntries'] as number) > 3, 'Expected totalEntries > 3');
    assert.ok(typeof sc['resourceUri'] === 'string', 'Expected resourceUri when truncated');
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
  });

  it('totalFiles + totalDirectories === totalEntries', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir, maxDepth: 2 },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    assert.equal(
      (sc['totalFiles'] as number) + (sc['totalDirectories'] as number),
      sc['totalEntries'] as number,
    );
  });

  it('returns ACCESS_DENIED for paths outside allowed roots', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: '/etc' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('returns NOT_DIRECTORY for a file path', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: join(env.tmpDir, 'alpha.txt') },
    });
    assertToolError(raw, 'NOT_DIRECTORY');
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
      name: 'make_dir',
      arguments: { paths: [newDir] },
    });
    assertOk(raw);

    // Verify content: terse summary with creation confirmation, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(
      summaryText.startsWith('create-directory:'),
      'Expected summary to start with "create-directory:"',
    );

    // Verify structured content has path and ok (P3 pattern)
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true, 'Expected ok: true');
    const createdPath = sc['path'] as string;
    assert.ok(createdPath, 'Expected path field to be set');
    assert.equal(
      createdPath.toLowerCase(),
      newDir.toLowerCase(),
      'Expected path field to be the created directory path',
    );
    // Verify summary contains the path (case-insensitive)
    assert.ok(
      summaryText.toLowerCase().includes(createdPath.toLowerCase()),
      'Expected summary to include the created path',
    );

    // Verify directory was actually created
    const statResult = await stat(newDir);
    assert.ok(statResult.isDirectory());
  });

  it('is idempotent — creating an existing directory is not an error', async () => {
    const existingDir = join(env.tmpDir, 'idempotent-dir');
    await mkdir(existingDir);
    const raw = await env.client.callTool({
      name: 'make_dir',
      arguments: { paths: [existingDir] },
    });
    assertOk(raw);
  });

  it('creates multiple directories via paths array', async () => {
    const d1 = join(env.tmpDir, 'batch-a');
    const d2 = join(env.tmpDir, 'batch-b');
    const raw = await env.client.callTool({
      name: 'make_dir',
      arguments: { paths: [d1, d2] },
    });
    assertOk(raw);
    // P3 pattern: only first path is processed
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true);
    assert.equal(
      (sc['path'] as string).toLowerCase(),
      d1.toLowerCase(),
      'Expected path to be the first directory in the array',
    );
    // Only d1 should be created
    assert.ok((await stat(d1)).isDirectory());
    // d2 is not created because P3 pattern processes only first path
    await assert.rejects(() => stat(d2), /ENOENT/);
  });

  it('rejects creation outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'make_dir',
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
      name: 'delete',
      arguments: { paths: [file] },
    });
    assertOk(raw);

    // Verify content: terse summary with deletion confirmation, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(
      summaryText.startsWith('delete-file:'),
      'Expected summary to start with "delete-file:"',
    );

    // Verify structured content has path and ok (P3 pattern)
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true, 'Expected ok: true');
    const deletedPath = sc['path'] as string;
    assert.ok(deletedPath, 'Expected path field to be set');
    assert.equal(
      deletedPath.toLowerCase(),
      file.toLowerCase(),
      'Expected path field to be the deleted file path',
    );
    // Verify summary contains the path (case-insensitive)
    assert.ok(
      summaryText.toLowerCase().includes(deletedPath.toLowerCase()),
      'Expected summary to include the deleted path',
    );

    // Verify file was actually deleted
    await assert.rejects(() => stat(file), /ENOENT/);
  });

  it('removes a directory recursively', async () => {
    const dir = join(env.tmpDir, 'to-delete-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'inner.txt'), 'inner', 'utf8');
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(raw);

    // Verify content: terse summary with deletion confirmation, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(
      summaryText.startsWith('delete-file:'),
      'Expected summary to start with "delete-file:"',
    );

    // Verify structured content has path and ok (P3 pattern)
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true, 'Expected ok: true');
    assert.ok(sc['path'], 'Expected path field to be set');

    // Verify directory was actually deleted
    await assert.rejects(() => stat(dir), /ENOENT/);
  });

  it('returns NOT_FOUND error for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [join(env.tmpDir, 'ghost.txt')] },
    });
    assertToolError(raw, 'NOT_FOUND');
  });

  it('ignoreIfNotExists suppresses NOT_FOUND', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: {
        paths: [join(env.tmpDir, 'definitely-not-here.txt')],
        ignoreIfNotExists: true,
      },
    });
    assertOk(raw);
  });

  it('returns ACCESS_DENIED error when deleting workspace root', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [env.tmpDir], recursive: true },
    });
    assertToolError(raw, 'ACCESS_DENIED');
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
      name: 'move',
      arguments: { sources: [src], destination: dst },
    });
    assertOk(raw);

    // Verify content: terse summary with source → destination, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(summaryText.startsWith('move-file:'), 'Expected summary to start with "move-file:"');
    assert.ok(summaryText.includes('→'), 'Expected summary to include arrow (→) separator');

    // Verify structured content has from/to/ok (P3 pattern)
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true, 'Expected ok: true');
    assert.equal(
      (sc['from'] as string).toLowerCase(),
      src.toLowerCase(),
      'Expected from field to be source path',
    );
    assert.equal(
      (sc['to'] as string).toLowerCase(),
      dst.toLowerCase(),
      'Expected to field to be destination path',
    );

    // Verify file was actually moved
    await assert.rejects(() => stat(src), /ENOENT/);
    const content = await readFile(dst, 'utf8');
    assert.equal(content, 'move me');
  });

  it('returns isError for total failure when source is missing', async () => {
    const raw = await env.client.callTool({
      name: 'move',
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
      name: 'find_files',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
        cursor: 'not-a-valid-cursor',
      },
    });
    assertToolError(raw, 'INVALID_INPUT');
  });
});

// ─── array size limits ──────────────────────────────────────────────────────

describe('array size limits', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('make_dir rejects > 1000 paths', async () => {
    const paths = Array.from({ length: 1001 }, (_, i) => join(env.tmpDir, `dir-${i}`));
    const raw = await env.client.callTool({
      name: 'make_dir',
      arguments: { paths },
    });
    assertToolError(raw);
    // Verify error mentions the size constraint
    const textBlock = raw.content.find(
      (b): b is { type: string; text: string } => typeof b.text === 'string',
    );
    assert.ok(textBlock?.text.includes('1000'), 'Expected error to mention the 1000 item limit');
  });
});
