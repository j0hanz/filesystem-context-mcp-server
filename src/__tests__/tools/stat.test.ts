/**
 * Integration tests for stat and stat_many tools.
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
} from '../helpers.js';

describe('stat tool', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = path.join(env.tmpDir, 'stat-test.txt');
    await fs.writeFile(file, 'hello stat\n', 'utf8');
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
    const info = sc['info'] as Record<string, unknown>;
    assert.ok(info, 'Expected info field');
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
    const info = sc['info'] as Record<string, unknown>;
    assert.equal(info['type'], 'directory');
  });

  it('returns NOT_FOUND for a missing path', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: path.join(env.tmpDir, 'does-not-exist.txt') },
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
    fileA = path.join(env.tmpDir, 'a.txt');
    fileB = path.join(env.tmpDir, 'b.txt');
    await fs.writeFile(fileA, 'file-a', 'utf8');
    await fs.writeFile(fileB, 'file-b', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns results for multiple paths', async () => {
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [fileA, fileB] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 2);
    for (const r of results) {
      const info = r['info'] as Record<string, unknown>;
      assert.ok(info, `Expected info for path ${r['path'] as string}`);
      assert.equal(info['type'], 'file');
    }
  });

  it('includes per-path error for missing entries', async () => {
    const missing = path.join(env.tmpDir, 'missing.txt');
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [fileA, missing] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Array<Record<string, unknown>>;
    const missingResult = results.find((r) => r['path'] === missing);
    assert.ok(missingResult, 'Expected result entry for the missing file');
    const error = missingResult['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'Expected error field on missing path result');
    assert.equal(error['code'], 'NOT_FOUND');
    assert.equal(typeof error['message'], 'string');
  });

  it('rejects empty paths array (schema validation)', async () => {
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });
});
