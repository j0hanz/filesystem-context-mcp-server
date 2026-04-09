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
    const result = raw;
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
    const result = raw;
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
    assertToolError(raw, 'E_NOT_FOUND');
  });

  it('returns E_ACCESS_DENIED outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: '/etc/hostname' },
    });
    assertToolError(raw, 'E_ACCESS_DENIED');
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
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(typeof sc['bytesWritten'] === 'number' && sc['bytesWritten'] > 0);
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
    assertToolError(raw, 'E_ACCESS_DENIED');
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
    const result = raw;
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
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Array<Record<string, unknown>>;
    const missingResult = results.find((r) => r['path'] === missing);
    assert.ok(missingResult, 'Expected entry for missing file');
    const error = missingResult['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'Expected error field for missing file');
    assert.equal(error['code'], 'E_NOT_FOUND');
    assert.equal(typeof error['message'], 'string');
  });

  it('reads with startLine/endLine range', async () => {
    const rangeFile = path.join(env.tmpDir, 'range.txt');
    await fs.writeFile(rangeFile, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths: [rangeFile], startLine: 2, endLine: 4 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    const first = results[0];
    assert.ok(first, 'Expected first result');
    const content = first['content'] as string;
    assert.ok(content.includes('L2'), 'Should include L2');
    assert.ok(content.includes('L4'), 'Should include L4');
    assert.ok(!content.includes('L1'), 'Should not include L1');
    assert.ok(!content.includes('L5'), 'Should not include L5');
    assert.equal(first['startLine'], 2);
    assert.equal(first['endLine'], 4);
  });

  it('rejects binary files with per-path error', async () => {
    const binFile = path.join(env.tmpDir, 'binary.bin');
    // Write bytes that include a null byte to trigger binary detection
    await fs.writeFile(binFile, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths: [fileA, binFile] },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Array<Record<string, unknown>>;
    const binResult = results.find((r) =>
      (r['path'] as string).includes('binary.bin')
    );
    assert.ok(binResult, 'Expected entry for binary file');
    const binError = binResult['error'] as Record<string, unknown> | undefined;
    assert.ok(binError, 'Expected error for binary file');
    assert.equal(typeof binError['message'], 'string');
    // Text file should still succeed
    const textResult = results.find((r) =>
      (r['path'] as string).includes('a.txt')
    );
    assert.ok(textResult, 'Expected entry for text file');
    assert.ok(textResult['content'], 'Text file should have content');
  });
});

// ─── read_many budget ────────────────────────────────────────────────────────

describe('read_many tool budget enforcement', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('skips files that exceed maxTotalSize budget', async () => {
    // DEFAULT_READ_MANY_MAX_TOTAL_SIZE is 512 KiB.
    // Create 3 files of ~200 KiB each (600 KiB total > 512 KiB budget).
    const bigContent = 'x'.repeat(200 * 1024) + '\n';
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = path.join(env.tmpDir, `big_${i}.txt`);
      await fs.writeFile(p, bigContent, 'utf8');
      paths.push(p);
    }

    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 3);

    // At least one file should be skipped due to budget
    const skipped = results.filter((r) => {
      const err = r['error'] as Record<string, unknown> | undefined;
      return (
        err !== undefined &&
        typeof err['message'] === 'string' &&
        err['message'].includes('maxTotalSize')
      );
    });
    assert.ok(
      skipped.length > 0,
      'Expected at least one file skipped due to budget'
    );

    // First files should have succeeded
    const succeeded = results.filter(
      (r) => r['content'] !== undefined && r['error'] === undefined
    );
    assert.ok(succeeded.length > 0, 'Expected at least one file to succeed');
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
    const result = raw;
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
    assertOk(raw);
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(
      actual,
      'original content\n',
      'File should not be modified in dryRun'
    );
  });

  it('rejects edits with an empty oldText target', async () => {
    const file = path.join(env.tmpDir, 'empty-target.txt');
    await fs.writeFile(file, 'content\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: '', newText: 'prefix' }],
      },
    });
    assertToolError(raw);
    const text = (raw as { content: Array<{ text?: string }> }).content[0]
      ?.text;
    assert.match(text ?? '', /oldText required/u);
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
    assertToolError(raw, 'E_INVALID_INPUT');
  });

  it('applies sequential edits against updated content', async () => {
    const file = path.join(env.tmpDir, 'sequential.txt');
    await fs.writeFile(file, 'alpha\nbeta\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [
          { oldText: 'beta', newText: 'gamma' },
          { oldText: 'gamma', newText: 'delta' },
        ],
      },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['appliedEdits'], 2);

    const actual = await fs.readFile(file, 'utf8');
    assert.equal(actual, 'alpha\ndelta\n');
  });

  it('returns diff and stats in dryRun mode without modifying the file', async () => {
    const file = path.join(env.tmpDir, 'dry-diff.txt');
    await fs.writeFile(file, 'alpha\nbeta\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'beta', newText: 'beta-1\nbeta-2' }],
        dryRun: true,
      },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['appliedEdits'], 1);
    assert.equal(sc['linesAdded'], 2);
    assert.equal(sc['linesRemoved'], 1);
    assert.match(sc['diff'] as string, /^--- dry-diff\.txt/m);
    assert.match(sc['diff'] as string, /^\+beta-1$/m);
    assert.match(sc['diff'] as string, /^\+beta-2$/m);

    const actual = await fs.readFile(file, 'utf8');
    assert.equal(actual, 'alpha\nbeta\n');
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
    const result = raw;
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
    assertOk(raw);
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(
      actual,
      ORIGINAL_CONTENT,
      'File must be unchanged in dryRun mode'
    );
  });

  it('returns E_INVALID_INPUT when patch has no effect', async () => {
    await fs.writeFile(file, ORIGINAL_CONTENT, 'utf8');
    // Patch that targets content not present in the file — applyPatch returns
    // the original string (not false) when context lines match but the removed
    // line is absent, so the patched output equals the original.
    const patch =
      [
        `--- a/patch-target.txt`,
        `+++ b/patch-target.txt`,
        `@@ -1,3 +1,3 @@`,
        ` alpha`,
        `-BETA`,
        `+BETA`,
        ` gamma`,
      ].join('\n') + '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: file, patch },
    });
    assertToolError(raw, 'E_INVALID_INPUT');
    const actual = await fs.readFile(file, 'utf8');
    assert.equal(actual, ORIGINAL_CONTENT, 'File must be unchanged');
  });
});
