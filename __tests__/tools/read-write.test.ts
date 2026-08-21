/**
 * Integration tests for file I/O tools: read, write, read_many, edit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
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

    // Check content blocks: first is file content text, second is resource_link
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    assert.ok((result.content[0] as Record<string, unknown>).text?.toString().includes('line1'));
    assert.equal(result.content[1].type, 'resource_link');

    // Check structured content
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 1);
    const value = results[0]?.['value'] as Record<string, unknown>;
    assert.ok(value['mimeType']);
    assert.ok(value['resourceUri']);
    assert.ok((value['resourceUri'] as string).includes('filesystem-mcp://file/'));
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
    const results = sc['results'] as Record<string, unknown>[];
    const value = results[0]?.['value'] as Record<string, unknown>;
    assert.equal(value['startLine'], 2);
    assert.equal(value['endLine'], 2);
  });

  it('hashes the returned content (not the full file) for partial reads', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, head: 1, includeHash: true },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    const value = results[0]?.['value'] as Record<string, unknown>;
    const returnedContent = value['content'] as string;
    const expectedHash = createHash('sha256').update(returnedContent, 'utf8').digest('hex');
    assert.equal(value['contentHash'], expectedHash);
    const fullFileHash = createHash('sha256').update('line1\nline2\nline3\n', 'utf8').digest('hex');
    assert.notEqual(value['contentHash'], fullFileHash);

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
    const results = sc['results'] as Record<string, unknown>[];
    const value = results[0]?.['value'] as Record<string, unknown>;
    assert.equal(value['continuation'], undefined);
    assert.equal(value['hasMoreLines'], undefined);
    // Check for resource link
    assert.equal(raw.content.length, 2);
    assert.equal(raw.content[1].type, 'resource_link');
  });

  it('returns NOT_FOUND for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: join(env.tmpDir, 'missing.txt') },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    const error = results[0]?.['error'] as Record<string, unknown>;
    assert.equal(error?.['code'], 'NOT_FOUND');
  });

  it('returns ACCESS_DENIED outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      // os.tmpdir() is a real, existing directory outside env.tmpDir — a
      // genuine non-root grant target, so this still exercises the
      // legacy-era fail-close path (unlike a path whose full ancestor chain
      // is missing, which now correctly fails ACCESS_DENIED instead).
      arguments: { path: join(tmpdir(), 'fsmcp-security-outside.txt') },
    });
    assertInputRequiredFailClose(raw);
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
    const results = sc['results'] as Record<string, unknown>[];
    const first = results[0]?.['value'] as Record<string, unknown>;
    assert.strictEqual(
      (results[0]?.['path'] as string).toLowerCase(),
      absPath.toLowerCase(),
      'path in output must be the resolved absolute path',
    );
    assert.ok(first, 'Expected value payload for single read');
  });

  it('read returns summary text block with resource link', async () => {
    const tsFile = join(env.tmpDir, 'test.ts');
    await writeFile(tsFile, 'const x = 1;\nconst y = 2;\nconst z = 3;\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: tsFile },
    });

    assertOk(raw);

    // Check text block contains file content
    assert.equal(raw.content.length, 2);
    assert.equal(raw.content[0].type, 'text');
    const textContent = (raw.content[0] as Record<string, unknown>).text as string;
    assert.ok(textContent.includes('const x'));

    // Check resource_link
    const resourceLink = raw.content[1] as Record<string, unknown>;
    assert.equal(resourceLink.type, 'resource_link');
    assert.match(resourceLink.uri as string, /^filesystem-mcp:\/\/file\//);
    assert.ok((resourceLink.mimeType as string).includes('text'));
    assert.ok((resourceLink.annotations as Record<string, unknown>)?.audience);

    // Check structured content
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    const value = results[0]?.['value'] as Record<string, unknown>;
    assert.ok((value['mimeType'] as string).includes('text'));
    assert.equal(value['kind'], 'text');
    assert.ok(value['resourceUri']);
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
    const sc1Results = sc1['results'] as Record<string, unknown>[];
    const sc1Value = sc1Results[0]?.['value'] as Record<string, unknown>;
    assert.ok(sc1Value['resourceUri']);
    // totalLines may be undefined for partial reads, but linesRead should reflect what was read
    if (sc1Value['totalLines']) {
      assert.equal(sc1Value['totalLines'], 101); // 100 lines + newline makes 101 total lines
    }
    assert.equal(sc1Value['linesRead'], 10);
    assert.equal(sc1Value['hasMoreLines'], true);
    assert.ok(sc1Value['continuation']);

    // Follow continuation to read next chunk
    const continuation = sc1Value['continuation'] as Record<string, unknown>;
    const raw2 = await env.client.callTool({
      name: continuation.tool as string,
      arguments: continuation.args as Record<string, unknown>,
    });

    assertOk(raw2);
    const sc2 = getStructured(raw2);
    const sc2Results = sc2['results'] as Record<string, unknown>[];
    const sc2Value = sc2Results[0]?.['value'] as Record<string, unknown>;
    // Second chunk should also have resource link
    assert.equal(raw2.content.length, 2);
    assert.equal(raw2.content[1].type, 'resource_link');
    assert.ok(sc2Value['resourceUri']);
  });

  it('read rejects both path and paths supplied (oneOf shape)', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, paths: [file] },
    });
    assertToolError(raw);
    const text = (raw as { content: { text?: string }[] }).content[0]?.text;
    assert.match(text ?? '', /path.*paths|both/iu);
  });

  it('read JSON schema has flat properties with optional path and paths', async () => {
    const tools = await env.client.listTools();
    const readTool = tools.tools.find((t) => t.name === 'read');
    assert.ok(readTool, 'read tool should exist');
    const inputSchema = readTool.inputSchema as Record<string, unknown>;
    // Schema should have properties at the top level (path and paths both optional)
    assert.ok(inputSchema.properties, 'Schema should have properties object');
    const properties = inputSchema.properties as Record<string, unknown>;
    assert.ok(properties.path, 'Schema should have path property');
    assert.ok(properties.paths, 'Schema should have paths property');
    // Should have other read-specific fields too
    assert.ok(properties.includeHash, 'Schema should have includeHash property');
    assert.ok(properties.head, 'Schema should have head property');
    assert.ok(properties.offset, 'Schema should have offset property');
    // Neither path/paths should be in the required array (both optional)
    const required = inputSchema.required as string[] | undefined;
    assert.ok(!required || required.length === 0, 'No properties should be required');
    // Should not have anyOf (that was the old union structure)
    assert.ok(!inputSchema.anyOf, 'Schema should not have anyOf (flattened structure)');
  });
});

// ─── create ──────────────────────────────────────────────────────────────────

describe('create tool', () => {
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
      name: 'create',
      arguments: { files: [{ path: file, content: 'hello world' }] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const created = (sc['files'] as Record<string, unknown>[])[0];
    assert.ok(created, 'Expected first file result');
    assert.equal(created['ok'], true);
    assert.equal(typeof created['path'], 'string');
    assert.equal(typeof created['size'], 'number');
    assert.equal(created['size'], 11); // "hello world" is 11 bytes
    assert.equal(created['lineCount'], 1);
    assert.ok(typeof created['mimeType'] === 'string');
    assert.ok(typeof created['kind'] === 'string');
    assert.ok(typeof created['resourceUri'] === 'string');
    assert.ok(created['resourceUri'].includes('filesystem-mcp://file/'));
    assert.ok(typeof created['created'] === 'string');
    assert.ok(typeof created['modified'] === 'string');

    // Verify summary includes "create:" and filename
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('create:'));
    assert.ok(summary.includes('written.txt'));

    // Verify resource_link
    assert.equal(result.content[1].type, 'resource_link');
    const link = result.content[1] as Record<string, unknown>;
    assert.ok((link.uri as string).includes('filesystem-mcp://file/'));

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'hello world');
  });

  it('overwrites an existing file', async () => {
    const file = join(env.tmpDir, 'overwrite.txt');
    await writeFile(file, 'old content', 'utf8');
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'new content' }] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const created = (sc['files'] as Record<string, unknown>[])[0];
    assert.ok(created, 'Expected first file result');
    assert.equal(created['ok'], true);
    assert.equal(created['size'], 11); // "new content" is 11 bytes
    assert.equal(created['lineCount'], 1);
    assert.ok(typeof created['resourceUri'] === 'string');

    // Verify summary includes "create:"
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('create:'));

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'new content');
  });

  it('creates parent directories and stores resource', async () => {
    const file = join(env.tmpDir, 'nested', 'deep', 'file.txt');
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'nested' }] },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const created = (sc['files'] as Record<string, unknown>[])[0];
    assert.ok(created, 'Expected first file result');
    assert.ok(created['resourceUri']);
    assert.ok(
      (result.content[1] as Record<string, unknown>).uri
        ?.toString()
        .includes('filesystem-mcp://file/'),
    );
    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'nested');
  });

  it('returns ACCESS_DENIED in failures[] for paths outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: '/tmp/escape.txt', content: 'bad' }] },
    });
    // Out-of-root fail-closes on the legacy-era wire harness — R6, nothing created.
    assertInputRequiredFailClose(raw);
    await assert.rejects(() => stat('/tmp/escape.txt'), /ENOENT/);
  });

  it('returns an error when files is omitted', async () => {
    const raw = await env.client.callTool({
      name: 'create',
      // intentionally no files
      arguments: {},
    });
    assert.ok(raw.isError, 'create without files must return an error');
  });

  it('a failure in the middle of a batch does not block the other files (parallel write)', async () => {
    const good1 = join(env.tmpDir, 'batch-good-1.txt');
    const good2 = join(env.tmpDir, 'batch-good-2.txt');
    const good3 = join(env.tmpDir, 'batch-good-3.txt');
    const good4 = join(env.tmpDir, 'batch-good-4.txt');
    // A regular file used as a path segment makes mkdir(recursive) fail with
    // ENOTDIR for any path underneath it — a guaranteed, non-grant-flow failure.
    const blocker = join(env.tmpDir, 'batch-blocker.txt');
    await writeFile(blocker, 'not a directory', 'utf8');
    const bad = join(blocker, 'sub', 'file.txt');

    const raw = await env.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: good1, content: 'one' },
          { path: good2, content: 'two' },
          { path: bad, content: 'nope' },
          { path: good3, content: 'three' },
          { path: good4, content: 'four' },
        ],
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const files = sc['files'] as Record<string, unknown>[];
    const failures = sc['failures'] as Record<string, unknown>[];

    assert.equal(
      files.length,
      4,
      'the four valid files all succeed despite the failure between them',
    );
    assert.equal(failures.length, 1, 'exactly one failure, for the invalid path');
    assert.equal(failures[0]?.['path'], bad);

    assert.equal(await readFile(good1, 'utf8'), 'one');
    assert.equal(await readFile(good2, 'utf8'), 'two');
    assert.equal(await readFile(good3, 'utf8'), 'three');
    assert.equal(await readFile(good4, 'utf8'), 'four');
  });
});

describe('create: partial failure support', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('creates valid files and reports failures for invalid paths in the same call', async () => {
    const good1 = join(env.tmpDir, 'partial-good1.txt');
    const good2 = join(env.tmpDir, 'partial-good2.txt');

    const result = await env.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: good1, content: 'hello' },
          { path: '/tmp/escape-bad.txt', content: 'evil' }, // outside allowed root
          { path: good2, content: 'world' },
        ],
      },
    });

    // A mixed in/out-of-root batch prompts input_required (the out-of-root entry
    // is grantable), so over the legacy-era wire harness it fail-closes — R14
    // atomic: round 1 creates neither good file.
    assertInputRequiredFailClose(result);
    await assert.rejects(() => stat(good1), /ENOENT/);
    await assert.rejects(() => stat(good2), /ENOENT/);
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

    // Check content blocks: first is file content text, rest are resource_links
    assert.equal(result.content.length, 3); // 1 content block + 2 resource_links
    assert.equal(result.content[0].type, 'text');
    assert.ok((result.content[0] as Record<string, unknown>).text?.toString().includes('content-'));
    assert.equal(result.content[1].type, 'resource_link');
    assert.equal(result.content[2].type, 'resource_link');

    // Check structured content
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);

    // Each result should have value.resourceUri instead of top-level content
    for (const r of results) {
      const value = r['value'] as Record<string, unknown>;
      assert.ok(value?.['resourceUri'], 'Expected resourceUri for each result');
      assert.equal(r['content'], undefined, 'Content should not be inline at result root');
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
    const value = first['value'] as Record<string, unknown>;
    assert.equal(value['startLine'], 2);
    assert.equal(value['endLine'], 4);
    assert.ok(value['resourceUri'], 'Expected resourceUri');
    assert.equal(first['content'], undefined, 'Content should not be inline at result root');
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
    const textValue = textResult['value'] as Record<string, unknown>;
    assert.ok(textValue['resourceUri'], 'Text file should have resourceUri');
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
    assert.ok((raw.content[0] as Record<string, unknown>).text?.toString().includes('content-'));

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
      const value = result['value'] as Record<string, unknown>;
      assert.ok(value['resourceUri'], `Expected resourceUri for file ${i}`);
      assert.equal(
        result['content'],
        undefined,
        `Content should be absent at result root for file ${i}`,
      );
      assert.equal(value['totalLines'], 2, `Expected 2 lines for file ${i}`);
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
      (r) =>
        (r['value'] as Record<string, unknown> | undefined)?.['resourceUri'] !== undefined &&
        r['error'] === undefined,
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
      const results = sc['results'] as Record<string, unknown>[];
      const value = results[0]?.['value'] as Record<string, unknown>;
      assert.strictEqual(value['content'], 'CDE');
      assert.strictEqual(value['bytesRead'], 3);
      assert.strictEqual(value['reachedEOF'], false);
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
      const results = sc['results'] as Record<string, unknown>[];
      const value = results[0]?.['value'] as Record<string, unknown>;
      assert.strictEqual(value['content'], 'IJ');
      assert.strictEqual(value['bytesRead'], 2);
      assert.strictEqual(value['reachedEOF'], true);
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
      const results = sc['results'] as Record<string, unknown>[];
      const value = results[0]?.['value'] as Record<string, unknown>;
      assert.strictEqual(value['content'], 'FGHIJ');
      assert.strictEqual(value['reachedEOF'], true);
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
      const results = sc['results'] as Record<string, unknown>[];
      const value = results[0]?.['value'] as Record<string, unknown>;
      assert.strictEqual(value['content'], '');
      assert.strictEqual(value['bytesRead'], 0);
      assert.strictEqual(value['reachedEOF'], true);
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
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const value = results[0]?.['value'] as Record<string, unknown> | undefined;
    assert.ok(value, 'edit result value must be present');

    // Verify structured content has required fields
    assert.equal(sc['ok'], true);
    assert.equal(typeof value['size'], 'number');
    assert.equal(typeof value['lineCount'], 'number');
    assert.equal(typeof value['mimeType'], 'string');
    assert.equal(typeof value['kind'], 'string');
    assert.equal(typeof value['resourceUri'], 'string');
    assert.ok((value['resourceUri'] as string).includes('filesystem-mcp://file/'));
    assert.equal(typeof value['modified'], 'string');
    assert.equal(value['appliedEdits'], 1);

    // Verify summary includes "edit:" and file path
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0].type, 'text');
    const summary = (result.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('edit:'));
    assert.ok(summary.includes('edit-me.txt'));

    // Verify resource_link
    assert.equal(result.content[1].type, 'resource_link');
    const link = result.content[1] as Record<string, unknown>;
    assert.ok((link.uri as string).includes('filesystem-mcp://file/'));

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
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const value = results[0]?.['value'] as Record<string, unknown> | undefined;
    assert.ok(value, 'edit result value must be present');

    // Verify structured content
    assert.equal(sc['ok'], true);
    assert.equal(value['appliedEdits'], 1);
    assert.equal(typeof value['resourceUri'], 'string');
    assert.ok((value['resourceUri'] as string).includes('filesystem-mcp://file/'));

    // Verify diff is present in dryRun
    assert.equal(typeof value['diff'], 'string');

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
    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const error = results[0]?.['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'edit error must be present');
    assert.equal(error['code'], 'INVALID_INPUT');
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
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const value = results[0]?.['value'] as Record<string, unknown> | undefined;
    assert.ok(value, 'edit result value must be present');
    assert.equal(value['appliedEdits'], 2);
    assert.equal(typeof value['resourceUri'], 'string');
    assert.ok((value['resourceUri'] as string).includes('filesystem-mcp://file/'));
    assert.equal(typeof value['mimeType'], 'string');
    assert.equal(typeof value['lineCount'], 'number');

    // Verify summary includes "edit:"
    const summary = (raw.content[0] as Record<string, unknown>).text as string;
    assert.ok(summary.includes('edit:'));

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
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const value = results[0]?.['value'] as Record<string, unknown> | undefined;
    assert.ok(value, 'edit result value must be present');
    assert.equal(value['appliedEdits'], 1);
    assert.equal(value['linesAdded'], 2);
    assert.equal(value['linesRemoved'], 1);
    assert.equal(typeof value['resourceUri'], 'string');
    assert.ok((value['resourceUri'] as string).includes('filesystem-mcp://file/'));
    assert.match(value['diff'] as string, /^--- dry-diff\.txt/m);
    assert.match(value['diff'] as string, /^\+beta-1$/m);
    assert.match(value['diff'] as string, /^\+beta-2$/m);

    const actual = await readFile(file, 'utf8');
    assert.equal(actual, 'alpha\nbeta\n');
  });

  it('fails when some edits are unmatched', async () => {
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
    assert.strictEqual(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const error = results[0]?.['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'edit result error must be present');
    assert.equal(error['code'], 'INVALID_INPUT');
    assert.match(error['message'] as string, /failed to match/);
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

    assertOk(raw);
    const sc = getStructured(raw);
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 1);
    const error = results[0]?.['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'edit error must be present');
    assert.equal(error['code'], 'INVALID_INPUT');
    const actual = await readFile(file);
    assert.deepEqual(actual, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  });
});

// (apply_patch removed)
