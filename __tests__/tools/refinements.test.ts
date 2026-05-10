import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

// ─── apply_patch multi-file (R3 + R12) ──────────────────────────────────────

describe('apply_patch multi-file', () => {
  let env: TestEnv;
  let fileA: string;
  let fileB: string;

  before(async () => {
    env = await createTestEnv();
    fileA = join(env.tmpDir, 'alpha.txt');
    fileB = join(env.tmpDir, 'beta.txt');
    await writeFile(fileA, 'one\ntwo\nthree\n', 'utf8');
    await writeFile(fileB, 'AAA\nBBB\nCCC\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies patches to multiple files with per-file results', async () => {
    const patch =
      [
        '--- a/alpha.txt',
        '+++ b/alpha.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '--- a/beta.txt',
        '+++ b/beta.txt',
        '@@ -1,3 +1,3 @@',
        ' AAA',
        '-BBB',
        '+BBB_REPLACED',
        ' CCC',
      ].join('\n') + '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: env.tmpDir, patch },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    assert.equal(sc['ok'], true);
    const summary = sc['summary'] as Record<string, unknown>;
    assert.equal(summary['succeeded'], 2);
    assert.equal(summary['total'], 2);

    const files = sc['files'] as Record<string, unknown>[];
    assert.equal(files.length, 2);

    const alphaFile = files.find((f) => f['path'] === 'alpha.txt');
    assert.ok(alphaFile, 'Expected file result for alpha.txt');
    assert.equal(alphaFile['hunks'], 1);

    const betaFile = files.find((f) => f['path'] === 'beta.txt');
    assert.ok(betaFile, 'Expected file result for beta.txt');
    assert.equal(betaFile['hunks'], 1);

    const actualA = await readFile(fileA, 'utf8');
    assert.ok(actualA.includes('TWO'), 'alpha.txt should contain TWO');
    assert.ok(!actualA.includes('\ntwo\n'), 'alpha.txt original "two" gone');

    const actualB = await readFile(fileB, 'utf8');
    assert.ok(actualB.includes('BBB_REPLACED'), 'beta.txt should contain BBB_REPLACED');
  });

  it('reports per-file errors when one file is missing', async () => {
    await writeFile(fileA, 'one\ntwo\nthree\n', 'utf8');

    const patch =
      [
        '--- a/alpha.txt',
        '+++ b/alpha.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+PATCHED',
        ' three',
        '--- a/nonexistent.txt',
        '+++ b/nonexistent.txt',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
      ].join('\n') + '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: env.tmpDir, patch },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    // summary shows partial success
    const summary = sc['summary'] as Record<string, unknown>;
    assert.equal(summary['succeeded'], 1);
    assert.equal(summary['failed'], 1);
    assert.equal(summary['total'], 2);

    const files = sc['files'] as Record<string, unknown>[];
    assert.equal(files.length, 1, 'Only successful patches in files array');
    const alphaFile = files.find((f) => f['path'] === 'alpha.txt');
    assert.ok(alphaFile, 'Expected file result for alpha.txt');
  });

  it('dryRun:true does not modify files in multi-file mode', async () => {
    await writeFile(fileA, 'one\ntwo\nthree\n', 'utf8');
    await writeFile(fileB, 'AAA\nBBB\nCCC\n', 'utf8');

    const patch =
      [
        '--- a/alpha.txt',
        '+++ b/alpha.txt',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+DRY_TWO',
        ' three',
        '--- a/beta.txt',
        '+++ b/beta.txt',
        '@@ -1,3 +1,3 @@',
        ' AAA',
        '-BBB',
        '+DRY_BBB',
        ' CCC',
      ].join('\n') + '\n';

    const raw = await env.client.callTool({
      name: 'apply_patch',
      arguments: { path: env.tmpDir, patch, dryRun: true },
    });
    assertOk(raw);

    const actualA = await readFile(fileA, 'utf8');
    assert.equal(actualA, 'one\ntwo\nthree\n', 'alpha.txt unchanged');
    const actualB = await readFile(fileB, 'utf8');
    assert.equal(actualB, 'AAA\nBBB\nCCC\n', 'beta.txt unchanged');
  });
});

// ─── read tail (R11) ────────────────────────────────────────────────────────

describe('read tool tail parameter', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'lines.txt');
    await writeFile(file, 'line1\nline2\nline3\nline4\nline5\nline6\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('reads last N lines with tail parameter', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 3 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);
    assert.equal(sc['tail'], 3);
    assert.equal(sc['hasMoreLines'], true);

    const content = sc['content'] as string;
    assert.ok(content.includes('line4'), 'Should include line4');
    assert.ok(content.includes('line5'), 'Should include line5');
    assert.ok(content.includes('line6'), 'Should include line6');
    assert.ok(!content.includes('line1'), 'Should not include line1');
    assert.ok(!content.includes('line2'), 'Should not include line2');
    assert.ok(!content.includes('line3'), 'Should not include line3');
  });

  it('rejects tail combined with head', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 3, head: 3 },
    });
    assertToolError(raw);
  });

  it('rejects tail combined with startLine', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 3, startLine: 1 },
    });
    assertToolError(raw);
  });
});

// ─── read_many with tail (R11) ──────────────────────────────────────────────

describe('read_many tool with tail parameter', () => {
  let env: TestEnv;
  let fileA: string;
  let fileB: string;

  before(async () => {
    env = await createTestEnv();
    fileA = join(env.tmpDir, 'a.txt');
    fileB = join(env.tmpDir, 'b.txt');
    await writeFile(fileA, 'a1\na2\na3\na4\na5\n', 'utf8');
    await writeFile(fileB, 'b1\nb2\nb3\nb4\nb5\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('reads last N lines of each file', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [fileA, fileB], tail: 2 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);

    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);

    for (const result of results) {
      assert.equal(result['tail'], 2, 'Each result should have tail=2');
      assert.equal(result['hasMoreLines'], true);
      // With resource links, content is externalized
      assert.equal(result['content'], undefined, 'Content should be in resource link, not inline');
      assert.ok(result['resourceUri'], 'Should have resourceUri for tail read');
    }

    const resultA = results.find((r) => (r['path'] as string).includes('a.txt'));
    assert.ok(resultA);
    // Verify resourceUri is present for each result
    assert.ok(resultA['resourceUri'], 'Result A should have resourceUri');

    const resultB = results.find((r) => (r['path'] as string).includes('b.txt'));
    assert.ok(resultB);
    assert.ok(resultB['resourceUri'], 'Result B should have resourceUri');

    // Verify resource_link content block is present
    const contentLinks = raw.content.filter((b) => b.type === 'resource_link');
    assert.ok(contentLinks.length >= 2, 'Expected at least 2 resource links');
  });

  it('rejects tail combined with head in read_many', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [fileA], tail: 2, head: 2 },
    });
    assertToolError(raw);
  });
});

// ─── grep externalization with expiresAt (R14) ─────────────────────────────

describe('grep externalization with expiresAt', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    // Create enough files with enough matches to exceed MAX_INLINE_MATCHES (50)
    // Each file has multiple matching lines so we easily exceed 50 total matches
    for (let i = 0; i < 20; i++) {
      const lines: string[] = [];
      for (let j = 0; j < 10; j++) {
        lines.push(`FINDME_marker_${i}_${j} some text here`);
      }
      await writeFile(
        join(env.tmpDir, `data_${String(i).padStart(3, '0')}.txt`),
        lines.join('\n') + '\n',
        'utf8',
      );
    }
  });

  after(async () => {
    await env.cleanup();
  });

  it('externalizes large grep results and includes resourceUri', async () => {
    const raw = await env.client.callTool({
      name: 'search_text',
      arguments: {
        path: env.tmpDir,
        searchPattern: 'FINDME_marker',
        pattern: '**/*.txt',
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);

    const totalMatches = sc['totalMatches'] as number;
    assert.ok(totalMatches >= 50, `Expected >=50 matches, got ${totalMatches}`);

    // When externalized, resourceUri should be present
    const resourceUri = sc['resourceUri'] as string | undefined;
    assert.ok(resourceUri, 'resourceUri should be present for large results');
    assert.ok(
      resourceUri.startsWith('filesystem-mcp://result/'),
      'resourceUri should point to result store',
    );
    assert.equal(sc['continuation'], undefined, 'Externalized files should have no continuation');

    // Verify the resource_link content block is present
    const result = raw as Record<string, unknown>;
    const content = result.content as Record<string, unknown>[];
    const resourceLink = content.find((block) => block.type === 'resource_link');
    assert.ok(resourceLink, 'Expected a resource_link content block');
    // Verify the resource_link has proper structure
    assert.ok(resourceLink.uri, 'resource_link should have uri');
    assert.ok(resourceLink.mimeType, 'resource_link should have mimeType');
    assert.ok(resourceLink.size, 'resource_link should have size');
  });
});

describe('mv partial success', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it('returns error when one source fails to move', async () => {
    const src = join(env.tmpDir, 'exists.txt');
    const dest = join(env.tmpDir, 'moved-dir');
    await mkdir(dest, { recursive: true });
    await writeFile(src, 'content', 'utf8');

    // Move with one valid source and one missing source
    // P3 confirmation-only tools fail on first error, no partial success
    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        sources: [src, join(env.tmpDir, 'DOES_NOT_EXIST.txt')],
        destination: dest,
      },
    });
    // Tool should return an error because second source is missing
    assert.equal(raw.isError, true, 'Expected error for missing source');
    const result = raw as Record<string, unknown>;
    const content = result.content as Record<string, unknown>[];
    const textBlock = content.find(
      (b) => b && typeof b === 'object' && 'type' in b && b.type === 'text',
    );
    assert.ok(textBlock, 'Error should have text content block');
    const errorText = (textBlock as { text?: string }).text ?? '';
    assert.ok(
      errorText.includes('DOES_NOT_EXIST') || errorText.includes('NOT_FOUND'),
      `Error message should mention missing file: ${errorText}`,
    );
  });
});

describe('search_and_replace wholeWord', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });
  after(async () => {
    await env.cleanup();
  });

  it('only replaces whole-word matches when wholeWord:true', async () => {
    const file = join(env.tmpDir, 'words.txt');
    await writeFile(file, 'cat concatenate cats\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
        searchPattern: 'cat',
        replacement: 'dog',
        wholeWord: true,
        caseSensitive: true,
        dryRun: false,
      },
    });
    assertOk(raw);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(file, 'utf8');
    // 'cat' (standalone) -> 'dog'; 'concatenate', 'cats' must be unchanged
    assert.ok(content.includes('dog'), 'standalone "cat" must be replaced');
    assert.ok(content.includes('concatenate'), '"concatenate" must be unchanged');
    assert.ok(content.includes('cats'), '"cats" must be unchanged');
  });
});
