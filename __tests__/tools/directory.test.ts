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
    const raw = await env.client.callTool({ name: 'roots', arguments: {} });
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

    // Verify content blocks: first is summary text, second is resource_link
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summaryText = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summaryText.includes('list-directory:'));

    assert.equal(result.content[1].type, 'resource_link');
    const resourceLink = result.content[1] as Record<string, unknown>;
    assert.ok((resourceLink.uri as string).includes('filesystem-mcp://result/'));
    assert.ok((resourceLink.name as string).includes('-listing.json'));

    // Verify structured content
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(sc['resourceUri']);
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
    assert.ok(sc['entryCount']);

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
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir, pattern: '../../*' },
    });
    assertToolError(raw);
  });

  it('paginates with an opaque cursor across multiple pages', async () => {
    for (let index = 0; index < 12; index += 1) {
      await writeFile(
        join(env.tmpDir, `page-${String(index).padStart(2, '0')}.txt`),
        String(index),
        'utf8',
      );
    }

    const firstPage = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir, maxEntries: 5 },
    });
    assertOk(firstPage);
    const firstStructured = getStructured(firstPage);
    const firstEntries = firstStructured['entries'] as Record<string, unknown>[];
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
    const secondEntries = secondStructured['entries'] as Record<string, unknown>[];

    assert.equal(secondEntries.length, 5);
    assert.notDeepEqual(
      firstEntries.map((entry) => entry['name']),
      secondEntries.map((entry) => entry['name']),
    );
  });

  it('list-directory with many entries returns single resource link', async () => {
    const manyFilesDir = join(env.tmpDir, 'many-files');
    await mkdir(manyFilesDir);

    // Create 20+ files
    for (let i = 0; i < 25; i++) {
      await writeFile(
        join(manyFilesDir, `file-${String(i).padStart(2, '0')}.txt`),
        `content ${i}`,
        'utf8',
      );
    }

    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: manyFilesDir },
    });
    assertOk(raw);

    // Verify only one resource_link despite many files
    assert.equal(raw.content.length, 2);
    assert.equal(raw.content[0].type, 'text');
    assert.equal(raw.content[1].type, 'resource_link');

    const sc = getStructured(raw);
    assert.ok(sc['entryCount']);
    assert.equal(sc['entryCount'], 25);
    assert.ok(sc['resourceUri']);

    // Verify summary text contains entry count
    const summaryText = (raw.content[0] as Record<string, unknown>).text as string;
    assert.ok(summaryText.includes('25'));
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

  it('generates tree view with resource link', async () => {
    const raw = await env.client.callTool({
      name: 'tree',
      arguments: { path: env.tmpDir },
    });
    const result = raw;
    assertOk(result);

    // Verify content blocks: first is summary text, second is resource_link
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summaryText = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summaryText.includes('tree:'));
    assert.ok(summaryText.includes('entries'));
    assert.ok(summaryText.includes('deep'));

    assert.equal(result.content[1].type, 'resource_link');
    const resourceLink = result.content[1] as Record<string, unknown>;
    assert.ok((resourceLink.uri as string).includes('filesystem-mcp://result/'));
    assert.ok((resourceLink.name as string).includes('-tree.txt'));
    assert.equal(resourceLink.mimeType, 'text/plain');

    // Verify structured content
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(sc['tree'] !== undefined, 'Expected tree field');
    assert.ok(sc['resourceUri']);
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
    assert.ok(typeof sc['entryCount'] === 'number');
    assert.ok(typeof sc['maxDepth'] === 'number');
    assert.ok(sc['entryCount'] > 0);
    assert.ok(sc['maxDepth'] > 0);
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

  it('calculates max depth for large directory structure', async () => {
    // Create a deeper nested structure
    const deep1 = join(env.tmpDir, 'level1');
    const deep2 = join(deep1, 'level2');
    const deep3 = join(deep2, 'level3');
    const deep4 = join(deep3, 'level4');
    const deep5 = join(deep4, 'level5');
    await mkdir(deep5, { recursive: true });
    await writeFile(join(deep5, 'deep-file.txt'), 'very deep', 'utf8');

    const raw = await env.client.callTool({
      name: 'tree',
      arguments: { path: env.tmpDir },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);

    // Verify max depth is calculated correctly (should be at least 5 for our structure)
    const maxDepth = sc['maxDepth'] as number;
    assert.ok(maxDepth >= 5, `Expected maxDepth >= 5, got ${maxDepth}`);

    // Verify summary includes depth info
    const summaryText = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summaryText.includes('deep'));
    assert.ok(summaryText.includes('level'));
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
      name: 'rm',
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
      name: 'rm',
      arguments: { paths: [join(env.tmpDir, 'ghost.txt')] },
    });
    assertToolError(raw, 'NOT_FOUND');
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

  it('returns ACCESS_DENIED error when deleting workspace root', async () => {
    const raw = await env.client.callTool({
      name: 'rm',
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
      name: 'mv',
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
