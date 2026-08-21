/**
 * Integration tests for stat and stat_many tools.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertInputRequiredFailClose,
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

    assert.ok(result.content.length >= 1, 'Expected at least one content block');
    assert.equal(result.content[0].type, 'text');
    const summaryText = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summaryText.includes('stat-test.txt'), 'Summary should include filename');
    assert.ok(summaryText.includes('file'), 'Summary should include file type');

    // Verify structured content has all metadata fields
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(Array.isArray(results), true, 'Expected results array');
    assert.equal(results.length, 1, 'Expected 1 result for single-path call');
    const info = results[0]?.['value'] as Record<string, unknown>;
    assert.ok(info, 'Expected results[0].value');
    assert.equal(info['type'], 'file');
    assert.ok(typeof info['size'] === 'number' && info['size'] > 0);
    assert.equal(info['name'], 'stat-test.txt');
    assert.ok((info['path'] as string).endsWith('stat-test.txt'), 'Path should end with filename');
    assert.ok(info['modified'], 'Should have modified timestamp');
    assert.ok(info['created'], 'Should have created timestamp');
    assert.ok(info['accessed'], 'Should have accessed timestamp');
    assert.ok(typeof info['permissions'] === 'string', 'Should have permissions');
    assert.ok(typeof info['isHidden'] === 'boolean', 'Should have isHidden flag');
    const summary = sc['summary'] as Record<string, unknown>;
    assert.deepEqual(summary, { total: 1, succeeded: 1, failed: 0 });
    assert.equal(sc['fileCount'], 1);
    assert.equal(sc['dirCount'], 0);
  });

  it('returns dir info for an existing directory', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: env.tmpDir },
    });
    const result = raw;
    assertOk(result);

    assert.ok(result.content.length >= 1, 'Expected at least one content block');
    assert.equal(result.content[0].type, 'text');
    const summaryText = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summaryText.includes('directory'), 'Summary should include directory type');

    // Verify structured content for directory
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 1, 'Expected 1 result for single-path call');
    const info = results[0]?.['value'] as Record<string, unknown>;
    assert.equal(info['type'], 'directory');
    assert.ok(info['path'], 'Should have path');
    assert.ok(info['modified'], 'Should have modified timestamp');
    const summary = sc['summary'] as Record<string, unknown>;
    assert.deepEqual(summary, { total: 1, succeeded: 1, failed: 0 });
    assert.equal(sc['fileCount'], 0);
    assert.equal(sc['dirCount'], 1);
  });

  it('returns NOT_FOUND for a missing path', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: join(env.tmpDir, 'does-not-exist.txt') },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 1);
    const error = results[0]?.['error'] as Record<string, unknown>;
    assert.equal(error?.['code'], 'NOT_FOUND');
  });

  it('returns ACCESS_DENIED when path escapes allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      // os.tmpdir() is a real, existing directory outside the allowed root — a
      // genuine non-root grant target, so this still exercises the legacy-era
      // fail-close path (unlike a path whose full ancestor chain is missing,
      // which now correctly fails ACCESS_DENIED instead).
      arguments: { path: join(tmpdir(), 'fsmcp-security-outside.txt') },
    });
    assertInputRequiredFailClose(raw);
  });

  it('stat JSON schema has flat properties with optional path and paths', async () => {
    const tools = await env.client.listTools();
    const statTool = tools.tools.find((t) => t.name === 'stat');
    assert.ok(statTool, 'stat tool should exist');
    const inputSchema = statTool.inputSchema as Record<string, unknown>;
    // Schema should have properties at the top level (path and paths both optional)
    assert.ok(inputSchema.properties, 'Schema should have properties object');
    const properties = inputSchema.properties as Record<string, unknown>;
    assert.ok(properties.path, 'Schema should have path property');
    assert.ok(properties.paths, 'Schema should have paths property');
    // Neither should be in the required array (both optional)
    const required = inputSchema.required as string[] | undefined;
    assert.ok(!required || required.length === 0, 'No properties should be required');
    // Should not have anyOf (that was the old union structure)
    assert.ok(!inputSchema.anyOf, 'Schema should not have anyOf (flattened structure)');
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
      name: 'stat',
      arguments: { paths: [fileA, fileB] },
    });
    const result = raw;
    assertOk(result);

    // Verify content blocks: first is file info text, second is resource_link
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summaryText = (result.content[0] as Record<string, unknown>).text?.toString() ?? '';
    assert.ok(summaryText.split('\n').length >= 2, 'Expected multi-line text for batch stat');
    assert.ok(summaryText.includes('file'), 'Expected file type in text');

    assert.equal(result.content[1].type, 'resource_link');
    const resourceLink = result.content[1] as Record<string, unknown>;
    assert.ok(
      (resourceLink['name'] as string).endsWith(' paths'),
      `Expected resource name to end with ' paths', got '${String(resourceLink['name'])}'`,
    );
    assert.equal(resourceLink['mimeType'], 'application/json');
    assert.ok((resourceLink['uri'] as string).includes('filesystem-mcp://result/'));

    // Verify structured content
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    for (const r of results) {
      const info = r['value'] as Record<string, unknown>;
      assert.ok(info, `Expected info for path ${r['path'] as string}`);
      assert.equal(info['type'], 'file');
    }

    // Verify new fields
    assert.equal(sc['fileCount'], 2, 'Expected fileCount === 2');
    assert.equal(sc['dirCount'], 0, 'Expected dirCount === 0');
    assert.ok(
      (sc['resourceUri'] as string).includes('filesystem-mcp://result/'),
      'Expected resourceUri to point to a resource',
    );
  });

  it('includes per-path error for missing entries', async () => {
    const missing = join(env.tmpDir, 'missing.txt');
    const raw = await env.client.callTool({
      name: 'stat',
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
      name: 'stat',
      arguments: { paths: files },
    });
    const result = raw;
    assertOk(result);

    // Verify single resource_link (not split)
    assert.equal(result.content.length, 2, 'Expected summary + one resource_link');
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
      'Expected valid resourceUri',
    );
  });

  it('rejects empty paths array (schema validation)', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });
});
