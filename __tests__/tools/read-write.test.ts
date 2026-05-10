/**
 * Integration tests for file I/O tools: read, write, read_many, edit, apply_patch.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
    file = join(env.tmpDir, 'read-test.txt');
    await writeFile(file, 'line1\nline2\nline3\n', 'utf8');
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

    // Check content blocks: first is summary text, second is resource_link
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.ok((result.content[0] as Record<string, unknown>).text?.toString().includes('read:'));
    assert.equal(result.content[1].type, 'resource_link');

    // Check structured content
    const sc = getStructured(result);
    assert.ok(sc['mimeType']);
    assert.ok(sc['resourceUri']);
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
  });

  it('reads a specific line range', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, startLine: 2, endLine: 2 },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    // Check for resource link in response
    assert.equal(result.content.length, 2);
    assert.equal(result.content[1].type, 'resource_link');
    // Verify structured content has the range info
    assert.equal(sc['startLine'], 2);
    assert.equal(sc['endLine'], 2);
  });

  it('hashes the full file content even for partial reads', async () => {
    const expectedHash = createHash('sha256').update('line1\nline2\nline3\n', 'utf8').digest('hex');

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, head: 1, includeHash: true },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['contentHash'], expectedHash);
    // Check for resource link
    assert.equal(raw.content.length, 2);
    assert.equal(raw.content[1].type, 'resource_link');
  });

  it('does not mark head reads as truncated when the file fits exactly', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, head: 3 },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['continuation'], undefined);
    assert.equal(sc['hasMoreLines'], undefined);
    // Check for resource link
    assert.equal(raw.content.length, 2);
    assert.equal(raw.content[1].type, 'resource_link');
  });

  it('returns NOT_FOUND for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: join(env.tmpDir, 'missing.txt') },
    });
    assertToolError(raw, 'NOT_FOUND');
  });

  it('returns ACCESS_DENIED outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: '/etc/hostname' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('returns the resolved absolute path, not the input path', async () => {
    const absPath = join(env.tmpDir, 'read-test.txt');
    await writeFile(absPath, 'hello\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: absPath },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.strictEqual(
      (sc['path'] as string).toLowerCase(),
      absPath.toLowerCase(),
      'path in output must be the resolved absolute path',
    );
  });

  it('read returns summary text block with resource link', async () => {
    const tsFile = join(env.tmpDir, 'test.ts');
    await writeFile(tsFile, 'const x = 1;\nconst y = 2;\nconst z = 3;\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: tsFile },
    });

    assertOk(raw);

    // Check text block contains summary pattern
    assert.equal(raw.content.length, 2);
    assert.equal(raw.content[0].type, 'text');
    const textContent = (raw.content[0] as Record<string, unknown>).text as string;
    // Check for format: read: <name> · <lines> · <size> · <mime>
    assert.ok(textContent.includes('read:'));
    assert.ok(textContent.includes('lines'));
    assert.ok(textContent.includes('text/'));

    // Check resource_link
    const resourceLink = raw.content[1] as Record<string, unknown>;
    assert.equal(resourceLink.type, 'resource_link');
    assert.match(resourceLink.uri as string, /^filesystem-mcp:\/\/result\//);
    assert.ok((resourceLink.mimeType as string).includes('text'));
    assert.ok((resourceLink.annotations as Record<string, unknown>)?.audience);

    // Check structured content
    const sc = getStructured(raw);
    assert.ok((sc['mimeType'] as string).includes('text'));
    assert.equal(sc['kind'], 'text');
    assert.ok(sc['resourceUri']);
  });

  it('read with continuation returns resource link for each chunk', async () => {
    const largeFile = join(env.tmpDir, 'large.txt');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(largeFile, lines + '\n', 'utf8');

    // First read with head
    const raw1 = await env.client.callTool({
      name: 'read',
      arguments: { path: largeFile, head: 10 },
    });

    assertOk(raw1);
    assert.equal(raw1.content.length, 2);
    assert.equal(raw1.content[0].type, 'text');
    assert.equal(raw1.content[1].type, 'resource_link');

    const sc1 = getStructured(raw1);
    assert.ok(sc1['resourceUri']);
    // totalLines may be undefined for partial reads, but linesRead should reflect what was read
    if (sc1['totalLines']) {
      assert.equal(sc1['totalLines'], 101); // 100 lines + newline makes 101 total lines
    }
    assert.equal(sc1['linesRead'], 10);
    assert.equal(sc1['hasMoreLines'], true);
    assert.ok(sc1['continuation']);

    // Follow continuation to read next chunk
    const continuation = sc1['continuation'] as Record<string, unknown>;
    const raw2 = await env.client.callTool({
      name: continuation.tool as string,
      arguments: continuation.args as Record<string, unknown>,
    });

    assertOk(raw2);
    const sc2 = getStructured(raw2);
    // Second chunk should also have resource link
    assert.equal(raw2.content.length, 2);
    assert.equal(raw2.content[1].type, 'resource_link');
    assert.ok(sc2['resourceUri']);
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
    const file = join(env.tmpDir, 'written.txt');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'hello world' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(typeof sc['size'], 'number');
    assert.equal(sc['size'], 11); // "hello world" is 11 bytes
    assert.equal(sc['lineCount'], 1);
    assert.ok(typeof sc['mimeType'] === 'string');
    assert.ok(typeof sc['kind'] === 'string');
    assert.ok(typeof sc['resourceUri'] === 'string');
    assert.ok(sc['resourceUri'].includes('filesystem-mcp://result/'));
    assert.ok(typeof sc['created'] === 'string');
    assert.ok(typeof sc['modified'] === 'string');

    // Verify summary includes "write:" and filename
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('write:'));
    assert.ok(summary.includes('written.txt'));

    // Verify resource_link
    assert.equal(result.content[1].type, 'resource_link');
    const link = result.content[1] as Record<string, unknown>;
    assert.ok((link.uri as string).includes('filesystem-mcp://result/'));

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'hello world');
  });

  it('overwrites an existing file', async () => {
    const file = join(env.tmpDir, 'overwrite.txt');
    await writeFile(file, 'old content', 'utf8');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'new content' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['size'], 11); // "new content" is 11 bytes
    assert.equal(sc['lineCount'], 1);
    assert.ok(typeof sc['resourceUri'] === 'string');

    // Verify summary includes "write:"
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('write:'));

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'new content');
  });

  it('creates parent directories and stores resource', async () => {
    const file = join(env.tmpDir, 'nested', 'deep', 'file.txt');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'nested' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.ok(sc['resourceUri']);
    assert.ok(
      (result.content[1] as Record<string, unknown>).uri
        ?.toString()
        .includes('filesystem-mcp://result/'),
    );
    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'nested');
  });

  it('returns ACCESS_DENIED outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: '/tmp/escape.txt', content: 'bad' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('returns an error when path is omitted', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      // intentionally no path
      arguments: { content: 'hello' },
    });
    assert.ok(raw.isError, 'write without path must return an error');
  });
});

// ─── read_many ───────────────────────────────────────────────────────────────

describe('read_many tool', () => {
  let env: TestEnv;
  let fileA: string;
  let fileB: string;

  before(async () => {
    env = await createTestEnv();
    fileA = join(env.tmpDir, 'a.txt');
    fileB = join(env.tmpDir, 'b.txt');
    await writeFile(fileA, 'content-a', 'utf8');
    await writeFile(fileB, 'content-b', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('reads multiple files in one call', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [fileA, fileB] },
    });
    const result = raw;
    assertOk(result);

    // Check content blocks: first is summary text, rest are resource_links
    assert.equal(result.content.length, 3); // 1 summary + 2 resource_links
    assert.equal(result.content[0].type, 'text');
    assert.ok((result.content[0] as Record<string, unknown>).text?.toString().includes('read:'));
    assert.equal(result.content[1].type, 'resource_link');
    assert.equal(result.content[2].type, 'resource_link');

    // Check structured content
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);

    // Each result should have resourceUri instead of content
    for (const r of results) {
      assert.ok(r['resourceUri'], 'Expected resourceUri for each result');
      assert.equal(r['content'], undefined, 'Content should not be inline');
    }

    // Verify resource_links have correct names
    const linkNames = [
      (result.content[1] as Record<string, unknown>).name as string,
      (result.content[2] as Record<string, unknown>).name as string,
    ];
    assert.ok(linkNames.some((n) => n.includes('a.txt')));
    assert.ok(linkNames.some((n) => n.includes('b.txt')));
  });

  it('includes per-path error for missing files', async () => {
    const missing = join(env.tmpDir, 'missing.txt');
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [fileA, missing] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    const missingResult = results.find((r) => r['path'] === missing);
    assert.ok(missingResult, 'Expected entry for missing file');
    const error = missingResult['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'Expected error field for missing file');
    assert.equal(error['code'], 'NOT_FOUND');
    assert.equal(typeof error['message'], 'string');
  });

  it('reads with startLine/endLine range', async () => {
    const rangeFile = join(env.tmpDir, 'range.txt');
    await writeFile(rangeFile, 'L1\nL2\nL3\nL4\nL5\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [rangeFile], startLine: 2, endLine: 4 },
    });
    assertOk(raw);

    // Check for resource_link in content
    assert.equal(raw.content.length, 2); // summary + resource_link
    assert.equal(raw.content[0].type, 'text');
    assert.equal(raw.content[1].type, 'resource_link');

    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 1);
    const first = results[0];
    assert.ok(first, 'Expected first result');

    // Verify line range metadata
    assert.equal(first['startLine'], 2);
    assert.equal(first['endLine'], 4);
    assert.ok(first['resourceUri'], 'Expected resourceUri');
    assert.equal(first['content'], undefined, 'Content should not be inline');
  });

  it('rejects binary files with per-path error', async () => {
    const binFile = join(env.tmpDir, 'binary.bin');
    // Write bytes that include a null byte to trigger binary detection
    await writeFile(binFile, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [fileA, binFile] },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    const binResult = results.find((r) => (r['path'] as string).includes('binary.bin'));
    assert.ok(binResult, 'Expected entry for binary file');
    const binError = binResult['error'] as Record<string, unknown> | undefined;
    assert.ok(binError, 'Expected error for binary file');
    assert.equal(typeof binError['message'], 'string');
    // Text file should still succeed
    const textResult = results.find((r) => (r['path'] as string).includes('a.txt'));
    assert.ok(textResult, 'Expected entry for text file');
    assert.ok(textResult['resourceUri'], 'Text file should have resourceUri');
  });

  it('read_many with large file list creates proper resource links', async () => {
    // Create 5 small files
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(env.tmpDir, `file_${i}.txt`);
      await writeFile(p, `content-${i}\nline2`, 'utf8');
      paths.push(p);
    }

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths },
    });
    assertOk(raw);

    // Check content structure: 1 summary + 5 resource_links
    assert.equal(raw.content.length, 6);
    assert.equal(raw.content[0].type, 'text');
    assert.ok(
      (raw.content[0] as Record<string, unknown>).text?.toString().includes('read: 5 files'),
    );

    // Verify all resource_links
    for (let i = 1; i < 6; i++) {
      assert.equal(raw.content[i].type, 'resource_link');
    }

    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 5);

    // Each result should have resourceUri and no content
    for (let i = 0; i < 5; i++) {
      const result = results[i];
      assert.ok(result, `Expected result at index ${i}`);
      assert.equal(result['path'], paths[i], `Path mismatch at index ${i}`);
      assert.ok(result['resourceUri'], `Expected resourceUri for file ${i}`);
      assert.equal(result['content'], undefined, `Content should be absent for file ${i}`);
      assert.equal(result['totalLines'], 2, `Expected 2 lines for file ${i}`);
    }

    // Verify summary
    const summary = sc['summary'] as Record<string, unknown>;
    assert.equal(summary['total'], 5);
    assert.equal(summary['succeeded'], 5);
    assert.equal(summary['failed'], 0);
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
      const p = join(env.tmpDir, `big_${i}.txt`);
      await writeFile(p, bigContent, 'utf8');
      paths.push(p);
    }

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
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
    assert.ok(skipped.length > 0, 'Expected at least one file skipped due to budget');

    // First files should have succeeded
    const succeeded = results.filter(
      (r) => r['resourceUri'] !== undefined && r['error'] === undefined,
    );
    assert.ok(succeeded.length > 0, 'Expected at least one file to succeed');
  });
});

// ─── read byte-range ─────────────────────────────────────────────────────────

describe('read tool — byte-range', () => {
  it('reads middle bytes with offset and length', async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.tmpDir, 'bytes.txt'), 'ABCDEFGHIJ');
      const res = await env.client.callTool({
        name: 'read',
        arguments: {
          path: join(env.tmpDir, 'bytes.txt'),
          offset: 2,
          length: 3,
        },
      });
      assertOk(res);
      const sc = getStructured(res);
      assert.strictEqual(sc['content'], 'CDE');
      assert.strictEqual(sc['bytesRead'], 3);
      assert.strictEqual(sc['reachedEOF'], false);
    } finally {
      await env.cleanup();
    }
  });

  it('clamps length to file end and sets reachedEOF', async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.tmpDir, 'bytes.txt'), 'ABCDEFGHIJ');
      const res = await env.client.callTool({
        name: 'read',
        arguments: {
          path: join(env.tmpDir, 'bytes.txt'),
          offset: 8,
          length: 100,
        },
      });
      assertOk(res);
      const sc = getStructured(res);
      assert.strictEqual(sc['content'], 'IJ');
      assert.strictEqual(sc['bytesRead'], 2);
      assert.strictEqual(sc['reachedEOF'], true);
    } finally {
      await env.cleanup();
    }
  });

  it('reads to EOF when no length given', async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.tmpDir, 'bytes.txt'), 'ABCDEFGHIJ');
      const res = await env.client.callTool({
        name: 'read',
        arguments: { path: join(env.tmpDir, 'bytes.txt'), offset: 5 },
      });
      assertOk(res);
      const sc = getStructured(res);
      assert.strictEqual(sc['content'], 'FGHIJ');
      assert.strictEqual(sc['reachedEOF'], true);
    } finally {
      await env.cleanup();
    }
  });

  it('returns empty when offset is past EOF', async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.tmpDir, 'bytes.txt'), 'ABCDEFGHIJ');
      const res = await env.client.callTool({
        name: 'read',
        arguments: { path: join(env.tmpDir, 'bytes.txt'), offset: 999 },
      });
      assertOk(res);
      const sc = getStructured(res);
      assert.strictEqual(sc['content'], '');
      assert.strictEqual(sc['bytesRead'], 0);
      assert.strictEqual(sc['reachedEOF'], true);
    } finally {
      await env.cleanup();
    }
  });

  it('rejects offset combined with startLine', async () => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.tmpDir, 'bytes.txt'), 'ABCDEFGHIJ');
      const res = await env.client.callTool({
        name: 'read',
        arguments: {
          path: join(env.tmpDir, 'bytes.txt'),
          offset: 0,
          startLine: 1,
        },
      });
      assertToolError(res);
    } finally {
      await env.cleanup();
    }
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
    const file = join(env.tmpDir, 'edit-me.txt');
    await writeFile(file, 'foo bar baz\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'bar', newText: 'BAR' }],
      },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);

    // Verify structured content has required fields
    assert.equal(sc['ok'], true);
    assert.equal(typeof sc['size'], 'number');
    assert.equal(typeof sc['lineCount'], 'number');
    assert.equal(typeof sc['mimeType'], 'string');
    assert.equal(typeof sc['kind'], 'string');
    assert.equal(typeof sc['resourceUri'], 'string');
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
    assert.equal(typeof sc['modified'], 'string');
    assert.equal(sc['appliedEdits'], 1);

    // Verify summary includes "edit-file:" and file path
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('edit-file:'));
    assert.ok(summary.includes('edit-me.txt'));

    // Verify resource_link
    assert.equal(result.content[1].type, 'resource_link');
    const link = result.content[1] as Record<string, unknown>;
    assert.ok((link.uri as string).includes('filesystem-mcp://result/'));

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'foo BAR baz\n');
  });

  it('dryRun:true does not modify the file but stores in resource', async () => {
    const file = join(env.tmpDir, 'dry-edit.txt');
    await writeFile(file, 'original content\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'original', newText: 'replaced' }],
        dryRun: true,
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    // Verify structured content
    assert.equal(sc['ok'], true);
    assert.equal(sc['appliedEdits'], 1);
    assert.equal(typeof sc['resourceUri'], 'string');
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));

    // Verify diff is present in dryRun
    assert.equal(typeof sc['diff'], 'string');

    // File should not be modified
    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'original content\n', 'File should not be modified in dryRun');
  });

  it('rejects edits with an empty oldText target', async () => {
    const file = join(env.tmpDir, 'empty-target.txt');
    await writeFile(file, 'content\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: '', newText: 'prefix' }],
      },
    });
    assertToolError(raw);
    const text = (raw as { content: { text?: string }[] }).content[0]?.text;
    assert.match(text ?? '', /oldText/u);
  });

  it('reports unmatched edits when oldText is not found', async () => {
    const file = join(env.tmpDir, 'no-match.txt');
    await writeFile(file, 'some text\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'DOES NOT EXIST', newText: 'anything' }],
      },
    });
    assertToolError(raw, 'INVALID_INPUT');
  });

  it('applies sequential edits against updated content', async () => {
    const file = join(env.tmpDir, 'sequential.txt');
    await writeFile(file, 'alpha\nbeta\n', 'utf8');

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
    assert.equal(typeof sc['resourceUri'], 'string');
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
    assert.equal(typeof sc['mimeType'], 'string');
    assert.equal(typeof sc['lineCount'], 'number');

    // Verify summary includes "edit-file:"
    const summary = (raw.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('edit-file:'));

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'alpha\ndelta\n');
  });

  it('returns diff and stats in dryRun mode without modifying the file', async () => {
    const file = join(env.tmpDir, 'dry-diff.txt');
    await writeFile(file, 'alpha\nbeta\n', 'utf8');

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
    assert.equal(typeof sc['resourceUri'], 'string');
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));
    assert.match(sc['diff'] as string, /^--- dry-diff\.txt/m);
    assert.match(sc['diff'] as string, /^\+beta-1$/m);
    assert.match(sc['diff'] as string, /^\+beta-2$/m);

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'alpha\nbeta\n');
  });

  it('returns ok:true even when some edits are unmatched', async () => {
    const file = join(env.tmpDir, 'partial-edit.txt');
    await writeFile(file, 'hello world\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [
          { oldText: 'hello', newText: 'goodbye' },
          { oldText: 'DOES_NOT_EXIST', newText: 'x' },
        ],
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.strictEqual(sc['ok'], true, 'ok must be literal true even for partial edits');
    assert.ok(Array.isArray(sc['unmatchedEdits']), 'unmatchedEdits must be present');
    assert.strictEqual((sc['unmatchedEdits'] as string[]).length, 1);
  });

  it('rejects binary files instead of rewriting them as text', async () => {
    const file = join(env.tmpDir, 'binary-edit.bin');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));

    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'x', newText: 'y' }],
      },
    });

    assertToolError(raw, 'INVALID_INPUT');
    const actual = await readFile(file);
    assert.deepEqual(actual, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  });
});

// ─── apply_patch ─────────────────────────────────────────────────────────────

describe('apply_patch tool', () => {
  let env: TestEnv;
  let file: string;
  const ORIGINAL_CONTENT = 'alpha\nbeta\ngamma\n';

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'patch-target.txt');
    await writeFile(file, ORIGINAL_CONTENT, 'utf8');
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

    // Verify structured content has required fields
    assert.equal(typeof sc['size'], 'number');
    assert.equal(typeof sc['lineCount'], 'number');
    assert.equal(typeof sc['mimeType'], 'string');
    assert.equal(typeof sc['kind'], 'string');
    assert.equal(typeof sc['resourceUri'], 'string');
    assert.ok((sc['resourceUri'] as string).includes('filesystem-mcp://result/'));

    // Verify summary includes "apply-patch:" and file path
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('apply-patch:'));
    assert.ok(summary.includes('patch-target.txt'));

    // Verify resource_link
    assert.equal(result.content[1].type, 'resource_link');
    const link = result.content[1] as Record<string, unknown>;
    assert.ok((link.uri as string).includes('filesystem-mcp://result/'));

    const actual = await readFile(file, 'utf8');
    assert.ok(actual.includes('BETA'), 'Patch should replace "beta" with "BETA"');
    assert.ok(!actual.includes('\nbeta\n'), 'Original "beta" should be gone');
  });

  it('dryRun:true does not modify the file', async () => {
    // Reset file first
    await writeFile(file, ORIGINAL_CONTENT, 'utf8');
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
    const actual = await readFile(file, 'utf8');
    assert.equal(actual, ORIGINAL_CONTENT, 'File must be unchanged in dryRun mode');
  });

  it('returns INVALID_INPUT when patch has no effect', async () => {
    await writeFile(file, ORIGINAL_CONTENT, 'utf8');
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
    assertToolError(raw, 'INVALID_INPUT');
    const actual = await readFile(file, 'utf8');
    assert.equal(actual, ORIGINAL_CONTENT, 'File must be unchanged');
  });

  it('rejects binary files instead of patching decoded bytes', async () => {
    const binaryFile = join(env.tmpDir, 'patch-binary.bin');
    const original = Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]);
    await writeFile(binaryFile, original);

    const patch =
      ['--- a/patch-binary.bin', '+++ b/patch-binary.bin', '@@ -1 +1 @@', '-x', '+y'].join('\n') +
      '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: binaryFile, patch },
    });

    assertToolError(raw, 'INVALID_INPUT');
    const actual = await readFile(binaryFile);
    assert.deepEqual(actual, original);
  });
});
