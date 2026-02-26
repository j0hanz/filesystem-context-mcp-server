/**
 * Integration tests for search tools: grep (search_content), find (search_files),
 * and search_and_replace.
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

// ─── grep (search_content) ───────────────────────────────────────────────────

describe('grep tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await fs.writeFile(
      path.join(env.tmpDir, 'fruits.txt'),
      'apple\nbanana\ncherry\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(env.tmpDir, 'veggies.txt'),
      'carrot\napricot\ncucumber\n',
      'utf8'
    );
    const sub = path.join(env.tmpDir, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(
      path.join(sub, 'deep.txt'),
      'another apple here\n',
      'utf8'
    );
  });

  after(async () => {
    await env.cleanup();
  });

  it('finds literal matches across files', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, pattern: 'apple' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const matches = sc['matches'] as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(matches) && matches.length >= 2,
      'Should match apple in at least 2 files'
    );
  });

  it('finds regex matches', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, pattern: '^a[a-z]+', isRegex: true },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const matches = sc['matches'] as Array<Record<string, unknown>>;
    assert.ok(
      Array.isArray(matches) && matches.length > 0,
      'Should find lines starting with "a"'
    );
  });

  it('restricts search using filePattern', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, pattern: 'a', filePattern: '*.txt' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
  });

  it('returns empty matches for a pattern that is not found', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, pattern: 'ZZZNOMATCH' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const matches = sc['matches'] as Array<Record<string, unknown>>;
    assert.equal(matches.length, 0, 'Should return empty matches array');
  });
});

// ─── find (search_files) ─────────────────────────────────────────────────────

describe('find tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await fs.writeFile(path.join(env.tmpDir, 'match1.ts'), '', 'utf8');
    await fs.writeFile(path.join(env.tmpDir, 'match2.ts'), '', 'utf8');
    await fs.writeFile(path.join(env.tmpDir, 'other.json'), '{}', 'utf8');
    const sub = path.join(env.tmpDir, 'src');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'match3.ts'), '', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('finds files matching a glob pattern', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '**/*.ts' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.ok(results.length >= 3, 'Expected at least 3 .ts files');
  });

  it('excludes non-matching files', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '**/*.json' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.ok(results.every((r) => (r['path'] as string).endsWith('.json')));
  });

  it('returns empty results when no files match', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '**/*.neverexists' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 0);
  });
});

// ─── search_and_replace ──────────────────────────────────────────────────────

describe('search_and_replace tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await fs.writeFile(
      path.join(env.tmpDir, 'file1.txt'),
      'hello world\nhello again\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(env.tmpDir, 'file2.txt'),
      'goodbye world\n',
      'utf8'
    );
  });

  after(async () => {
    await env.cleanup();
  });

  it('replaces text in all matching files', async () => {
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: env.tmpDir,
        filePattern: '*.txt',
        searchPattern: 'world',
        replacement: 'WORLD',
      },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const file1 = await fs.readFile(path.join(env.tmpDir, 'file1.txt'), 'utf8');
    assert.ok(file1.includes('WORLD'), 'Expected replacement in file1');
    const file2 = await fs.readFile(path.join(env.tmpDir, 'file2.txt'), 'utf8');
    assert.ok(file2.includes('WORLD'), 'Expected replacement in file2');
  });

  it('dryRun:true does not modify any files', async () => {
    await fs.writeFile(path.join(env.tmpDir, 'dry.txt'), 'oldvalue\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: env.tmpDir,
        filePattern: 'dry.txt',
        searchPattern: 'oldvalue',
        replacement: 'newvalue',
        dryRun: true,
      },
    });
    assertOk(raw);
    const actual = await fs.readFile(path.join(env.tmpDir, 'dry.txt'), 'utf8');
    assert.equal(actual, 'oldvalue\n', 'File must be unchanged in dryRun');
  });

  it('supports regex replacement', async () => {
    const file = path.join(env.tmpDir, 'regex-test.txt');
    await fs.writeFile(file, 'cat123\ndog456\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: env.tmpDir,
        filePattern: 'regex-test.txt',
        searchPattern: '\\d+',
        replacement: 'NUM',
        isRegex: true,
      },
    });
    assertOk(raw);
    const actual = await fs.readFile(file, 'utf8');
    assert.ok(
      actual.includes('NUM'),
      'Regex replacement should have substituted digits'
    );
    assert.ok(!/\d/.exec(actual), 'No digits should remain');
  });

  it('returns E_ACCESS_DENIED when path escapes allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: '/tmp',
        filePattern: '*.txt',
        searchPattern: 'x',
        replacement: 'y',
      },
    });
    assertToolError(raw, 'E_ACCESS_DENIED');
  });
});
