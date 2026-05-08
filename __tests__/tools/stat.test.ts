/**
 * Integration tests for stat and stat_many tools.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

describe('stat tool', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'stat-test.txt');
    await writeFile(file, 'hello stat\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns file info for an existing file', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: file },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const info = sc['file'] as Record<string, unknown>;
    assert.ok(info, 'Expected file field');
    assert.equal(info['type'], 'file');
    assert.ok(typeof info['size'] === 'number' && info['size'] > 0);
    assert.equal(info['name'], 'stat-test.txt');
  });

  it('returns dir info for an existing directory', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: env.tmpDir },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const info = sc['file'] as Record<string, unknown>;
    assert.equal(info['type'], 'directory');
  });

  it('returns NOT_FOUND for a missing path', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: join(env.tmpDir, 'does-not-exist.txt') },
    });
    assertToolError(raw, 'NOT_FOUND');
  });

  it('returns ACCESS_DENIED when path escapes allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: '/etc/passwd' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });
});

describe('stat_many tool', () => {
  let env: TestEnv;
  let fileA: string;
  let fileB: string;

  before(async () => {
    env = await createTestEnv();
    fileA = join(env.tmpDir, 'a.txt');
    fileB = join(env.tmpDir, 'b.txt');
    await writeFile(fileA, 'file-a', 'utf8');
    await writeFile(fileB, 'file-b', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('gets stats for multiple files', async () => {
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [fileA, fileB] },
    });
    const result = raw;
    assertOk(result);

    // Verify content blocks: first is summary text, second is resource_link
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summaryText =
      (result.content[0] as Record<string, unknown>).text?.toString() ?? '';
    assert.ok(summaryText.includes('stat-many:'));
    assert.ok(summaryText.includes('2 files'));

    assert.equal(result.content[1].type, 'resource_link');
    const resourceLink = result.content[1] as Record<string, unknown>;
    assert.equal(resourceLink['name'], 'stats.json');
    assert.equal(resourceLink['mimeType'], 'application/json');
    assert.ok(
      (resourceLink['uri'] as string).includes('filesystem-mcp://result/')
    );

    // Verify structured content
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    for (const r of results) {
      const info = r['info'] as Record<string, unknown>;
      assert.ok(info, `Expected info for path ${r['path'] as string}`);
      assert.equal(info['type'], 'file');
    }

    // Verify new fields
    assert.equal(sc['fileCount'], 2, 'Expected fileCount === 2');
    assert.equal(sc['dirCount'], 0, 'Expected dirCount === 0');
    assert.ok(
      (sc['resourceUri'] as string).includes('filesystem-mcp://result/'),
      'Expected resourceUri to point to stats.json'
    );
  });

  it('includes per-path error for missing entries', async () => {
    const missing = join(env.tmpDir, 'missing.txt');
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [fileA, missing] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    const missingResult = results.find((r) => r['path'] === missing);
    assert.ok(missingResult, 'Expected result entry for the missing file');
    const error = missingResult['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'Expected error field on missing path result');
    assert.equal(error['code'], 'NOT_FOUND');
    assert.equal(typeof error['message'], 'string');
  });

  it('stat-many with large file list', async () => {
    // Create 10+ files and directories
    const files: string[] = [];
    for (let i = 0; i < 7; i++) {
      const file = join(env.tmpDir, `file-${i}.txt`);
      await writeFile(file, `content-${i}`, 'utf8');
      files.push(file);
    }

    // Also create subdirectories
    const { mkdir } = await import('node:fs/promises');
    for (let i = 0; i < 3; i++) {
      const dir = join(env.tmpDir, `dir-${i}`);
      await mkdir(dir, { recursive: true });
      files.push(dir);
    }

    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: files },
    });
    const result = raw;
    assertOk(result);

    // Verify single resource_link (not split)
    assert.equal(
      result.content.length,
      2,
      'Expected summary + one resource_link'
    );
    assert.equal(result.content[1].type, 'resource_link');

    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 10, 'Expected all 10 paths in stats array');

    // Verify file and directory counts
    assert.equal(sc['fileCount'], 7, 'Expected 7 files');
    assert.equal(sc['dirCount'], 3, 'Expected 3 directories');

    // Verify resourceUri
    assert.ok(
      (sc['resourceUri'] as string).includes('filesystem-mcp://result/'),
      'Expected valid resourceUri'
    );
  });

  it('rejects empty paths array (schema validation)', async () => {
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });
});
