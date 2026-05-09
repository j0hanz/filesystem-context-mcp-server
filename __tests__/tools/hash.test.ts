/**
 * Integration tests for calculate_hash and diff_files tools.
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

describe('calculate_hash tool', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'hash-me.txt');
    await writeFile(file, 'deterministic content\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('calculates file hash and stores in resource', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    // Verify structured content
    assert.equal(typeof sc['filePath'], 'string');
    assert(sc['filePath'].includes('hash-me.txt'));
    assert.deepEqual(sc['algorithms'], ['sha256']);
    assert(typeof sc['hashes'] === 'object');
    assert.equal(typeof sc['hashes']['sha256'], 'string');
    assert.ok((sc['hashes']['sha256'] as string).length > 0);
    assert.equal(sc['isDirectory'], false);
    assert.equal(typeof sc['resourceUri'], 'string');
    assert((sc['resourceUri'] as string).startsWith('filesystem-mcp://result/'));

    // Verify summary contains file name and algorithm
    const summary = raw.content[0];
    assert(summary && 'text' in summary);
    const text = (summary as { type: string; text: string }).text;
    assert(text.includes('hash-me.txt'));
    assert(text.includes('SHA-256'));
    assert(text.includes(':'));

    // Verify resource link
    const resourceLink = raw.content.find((c) => c && 'type' in c && c.type === 'resource_link');
    assert(resourceLink, 'Should have a resource_link');
    assert.equal((resourceLink as { name: string }).name, 'hashes.json');
  });

  it('calculate-hash with multiple algorithms', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file, algorithms: ['sha256', 'md5'] },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    // Verify both algorithms are computed
    assert.deepEqual(sc['algorithms'], ['sha256', 'md5']);
    assert.equal(typeof sc['hashes']['sha256'], 'string');
    assert.equal(typeof sc['hashes']['md5'], 'string');
    assert.ok((sc['hashes']['sha256'] as string).length > 0);
    assert.ok((sc['hashes']['md5'] as string).length > 0);

    // Verify summary shows primary algorithm (sha256)
    const summary = raw.content[0];
    assert(summary && 'text' in summary);
    const text = (summary as { type: string; text: string }).text;
    assert(text.includes('SHA-256'));

    // Verify resource link still present
    const resourceLink = raw.content.find((c) => c && 'type' in c && c.type === 'resource_link');
    assert(resourceLink, 'Should have a resource_link');
  });

  it('returns the same hash for identical content', async () => {
    const file2 = join(env.tmpDir, 'hash-copy.txt');
    await writeFile(file2, 'deterministic content\n', 'utf8');

    const raw1 = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file },
    });
    const raw2 = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file2 },
    });

    const sc1 = getStructured(raw1);
    const sc2 = getStructured(raw2);
    assert.equal(
      sc1['hashes']['sha256'],
      sc2['hashes']['sha256'],
      'Same content should produce same hash',
    );
  });

  it('returns a different hash after file content changes', async () => {
    const mutable = join(env.tmpDir, 'mutable.txt');
    await writeFile(mutable, 'version 1', 'utf8');
    const r1 = getStructured(
      await env.client.callTool({
        name: 'calculate_hash',
        arguments: { path: mutable },
      }),
    );
    await writeFile(mutable, 'version 2', 'utf8');
    const r2 = getStructured(
      await env.client.callTool({
        name: 'calculate_hash',
        arguments: { path: mutable },
      }),
    );
    assert.notEqual(
      r1['hashes']['sha256'],
      r2['hashes']['sha256'],
      'Different content should produce different hash',
    );
  });

  it('returns isDirectory:true and fileCount for a directory', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: env.tmpDir },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['isDirectory'], true);
    assert.equal(typeof sc['fileCount'], 'number');
    assert.equal(sc['algorithms'][0], 'sha256');
    assert.equal(typeof sc['hashes']['sha256'], 'string');
  });

  it('returns NOT_FOUND for a missing path', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: join(env.tmpDir, 'ghost.txt') },
    });
    assertToolError(raw, 'NOT_FOUND');
  });
});

describe('diff_files tool', () => {
  let env: TestEnv;
  let original: string;
  let modified: string;
  let identical: string;

  before(async () => {
    env = await createTestEnv();
    original = join(env.tmpDir, 'original.txt');
    modified = join(env.tmpDir, 'modified.txt');
    identical = join(env.tmpDir, 'identical.txt');
    await writeFile(original, 'line one\nline two\nline three\n', 'utf8');
    await writeFile(modified, 'line one\nline TWO CHANGED\nline three\n', 'utf8');
    await writeFile(identical, 'line one\nline two\nline three\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns a diff for two different files', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original, modified },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['isIdentical'], false);
    assert.equal(typeof sc['diff'], 'string');
    assert.ok((sc['diff'] as string).includes('TWO CHANGED'));
  });

  it('returns isIdentical:true for identical files', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original, modified: identical },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['isIdentical'], true);
  });

  it('returns NOT_FOUND when a file does not exist', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: {
        original: join(env.tmpDir, 'no-such-file.txt'),
        modified,
      },
    });
    assertToolError(raw, 'NOT_FOUND');
  });
});
