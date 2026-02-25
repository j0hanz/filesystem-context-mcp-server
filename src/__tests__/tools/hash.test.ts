/**
 * Integration tests for calculate_hash and diff_files tools.
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

describe('calculate_hash tool', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = path.join(env.tmpDir, 'hash-me.txt');
    await fs.writeFile(file, 'deterministic content\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns ok:true and a non-empty hash for a file', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(typeof sc['hash'], 'string');
    assert.ok((sc['hash'] as string).length > 0);
    assert.equal(sc['isDirectory'], false);
  });

  it('returns the same hash for identical content', async () => {
    const file2 = path.join(env.tmpDir, 'hash-copy.txt');
    await fs.writeFile(file2, 'deterministic content\n', 'utf8');

    const raw1 = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file },
    });
    const raw2 = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: file2 },
    });

    const sc1 = getStructured(raw1 as unknown as ToolResult);
    const sc2 = getStructured(raw2 as unknown as ToolResult);
    assert.equal(
      sc1['hash'],
      sc2['hash'],
      'Same content should produce same hash'
    );
  });

  it('returns a different hash after file content changes', async () => {
    const mutable = path.join(env.tmpDir, 'mutable.txt');
    await fs.writeFile(mutable, 'version 1', 'utf8');
    const r1 = getStructured(
      (await env.client.callTool({
        name: 'calculate_hash',
        arguments: { path: mutable },
      })) as unknown as ToolResult
    );
    await fs.writeFile(mutable, 'version 2', 'utf8');
    const r2 = getStructured(
      (await env.client.callTool({
        name: 'calculate_hash',
        arguments: { path: mutable },
      })) as unknown as ToolResult
    );
    assert.notEqual(
      r1['hash'],
      r2['hash'],
      'Different content should produce different hash'
    );
  });

  it('returns isDirectory:true and fileCount for a directory', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: env.tmpDir },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['isDirectory'], true);
    assert.equal(typeof sc['fileCount'], 'number');
  });

  it('returns E_NOT_FOUND for a missing path', async () => {
    const raw = await env.client.callTool({
      name: 'calculate_hash',
      arguments: { path: path.join(env.tmpDir, 'ghost.txt') },
    });
    assertToolError(raw as unknown as ToolResult, 'E_NOT_FOUND');
  });
});

describe('diff_files tool', () => {
  let env: TestEnv;
  let original: string;
  let modified: string;
  let identical: string;

  before(async () => {
    env = await createTestEnv();
    original = path.join(env.tmpDir, 'original.txt');
    modified = path.join(env.tmpDir, 'modified.txt');
    identical = path.join(env.tmpDir, 'identical.txt');
    await fs.writeFile(original, 'line one\nline two\nline three\n', 'utf8');
    await fs.writeFile(
      modified,
      'line one\nline TWO CHANGED\nline three\n',
      'utf8'
    );
    await fs.writeFile(identical, 'line one\nline two\nline three\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns a diff for two different files', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original, modified },
    });
    const result = raw as unknown as ToolResult;
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
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['isIdentical'], true);
  });

  it('returns E_NOT_FOUND when a file does not exist', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: {
        original: path.join(env.tmpDir, 'no-such-file.txt'),
        modified,
      },
    });
    assertToolError(raw as unknown as ToolResult, 'E_NOT_FOUND');
  });
});
