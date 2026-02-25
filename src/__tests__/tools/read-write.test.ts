/**
 * Integration tests for file I/O tools: read, write, read_many, edit, apply_patch.
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

// ─── read ────────────────────────────────────────────────────────────────────

describe('read tool', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = path.join(env.tmpDir, 'read-test.txt');
    await fs.writeFile(file, 'line1\nline2\nline3\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('reads the full file content', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const content = sc['content'] as string;
    assert.ok(content.includes('line1'));
    assert.ok(content.includes('line3'));
  });

  it('reads a specific line range', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, startLine: 2, endLine: 2 },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.ok((sc['content'] as string).includes('line2'));
    assert.ok(!(sc['content'] as string).includes('line1'));
    assert.ok(!(sc['content'] as string).includes('line3'));
  });

  it('returns E_NOT_FOUND for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: path.join(env.tmpDir, 'missing.txt') },
    });
    assertToolError(raw as unknown as ToolResult, 'E_NOT_FOUND');
  });

  it('returns E_ACCESS_DENIED outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: '/etc/hostname' },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
  });
});

// ─── write ───────────────────────────────────────────────────────────────────

describe('write tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('creates a new file with content', async () => {
    const file = path.join(env.tmpDir, 'written.txt');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'hello world' },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(
      typeof sc['bytesWritten'] === 'number' &&
        (sc['bytesWritten'] as number) > 0
    );
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(actual, 'hello world');
  });

  it('overwrites an existing file', async () => {
    const file = path.join(env.tmpDir, 'overwrite.txt');
    await fs.writeFile(file, 'old content', 'utf8');
    await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'new content' },
    });
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(actual, 'new content');
  });

  it('returns E_ACCESS_DENIED outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: '/tmp/escape.txt', content: 'bad' },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
  });
});

// ─── read_many ───────────────────────────────────────────────────────────────

describe('read_many tool', () => {
  let env: TestEnv;
  let fileA: string;
  let fileB: string;

  before(async () => {
    env = await createTestEnv();
    fileA = path.join(env.tmpDir, 'a.txt');
    fileB = path.join(env.tmpDir, 'b.txt');
    await fs.writeFile(fileA, 'content-a', 'utf8');
    await fs.writeFile(fileB, 'content-b', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('reads multiple files in one call', async () => {
    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths: [fileA, fileB] },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 2);
    const contents = results.map((r) => r['content'] as string);
    assert.ok(contents.some((c) => c.includes('content-a')));
    assert.ok(contents.some((c) => c.includes('content-b')));
  });

  it('includes per-path error for missing files', async () => {
    const missing = path.join(env.tmpDir, 'missing.txt');
    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths: [fileA, missing] },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Array<Record<string, unknown>>;
    const missingResult = results.find((r) => r['path'] === missing);
    assert.ok(missingResult, 'Expected entry for missing file');
    assert.ok(missingResult['error'], 'Expected error field for missing file');
  });
});

// ─── edit ────────────────────────────────────────────────────────────────────

describe('edit tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies a text replacement', async () => {
    const file = path.join(env.tmpDir, 'edit-me.txt');
    await fs.writeFile(file, 'foo bar baz\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'bar', newText: 'BAR' }],
      },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(actual, 'foo BAR baz\n');
  });

  it('dryRun:true does not modify the file', async () => {
    const file = path.join(env.tmpDir, 'dry-edit.txt');
    await fs.writeFile(file, 'original content\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'original', newText: 'replaced' }],
        dryRun: true,
      },
    });
    assertOk(raw as unknown as ToolResult);
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(
      actual,
      'original content\n',
      'File should not be modified in dryRun'
    );
  });

  it('reports unmatched edits when oldText is not found', async () => {
    const file = path.join(env.tmpDir, 'no-match.txt');
    await fs.writeFile(file, 'some text\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'DOES NOT EXIST', newText: 'anything' }],
      },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    const unmatched = sc['unmatchedEdits'] as unknown[];
    assert.ok(
      Array.isArray(unmatched) && unmatched.length > 0,
      'Expected unmatchedEdits'
    );
  });
});

// ─── apply_patch ─────────────────────────────────────────────────────────────

describe('apply_patch tool', () => {
  let env: TestEnv;
  let file: string;
  const ORIGINAL_CONTENT = 'alpha\nbeta\ngamma\n';

  before(async () => {
    env = await createTestEnv();
    file = path.join(env.tmpDir, 'patch-target.txt');
    await fs.writeFile(file, ORIGINAL_CONTENT, 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies a valid unified diff patch to a file', async () => {
    const patch =
      [
        `--- a/patch-target.txt`,
        `+++ b/patch-target.txt`,
        `@@ -1,3 +1,3 @@`,
        ` alpha`,
        `-beta`,
        `+BETA`,
        ` gamma`,
      ].join('\n') + '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: file, patch },
    });
    const result = raw as unknown as ToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const actual = await fs.readFile(file, 'utf8');
    assert.ok(
      actual.includes('BETA'),
      'Patch should replace "beta" with "BETA"'
    );
    assert.ok(!actual.includes('\nbeta\n'), 'Original "beta" should be gone');
  });

  it('dryRun:true does not modify the file', async () => {
    // Reset file first
    await fs.writeFile(file, ORIGINAL_CONTENT, 'utf8');
    const patch =
      [
        `--- a/patch-target.txt`,
        `+++ b/patch-target.txt`,
        `@@ -1,3 +1,3 @@`,
        ` alpha`,
        `-beta`,
        `+DRY`,
        ` gamma`,
      ].join('\n') + '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: file, patch, dryRun: true },
    });
    assertOk(raw as unknown as ToolResult);
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(
      actual,
      ORIGINAL_CONTENT,
      'File must be unchanged in dryRun mode'
    );
  });
});
