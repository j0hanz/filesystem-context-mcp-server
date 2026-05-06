import assert from 'node:assert/strict';
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
    assert.equal(sc['applied'], true);
    assert.equal(sc['hunksApplied'], 2);
    assert.equal(typeof sc['linesAdded'], 'number');
    assert.equal(typeof sc['linesRemoved'], 'number');
    assert.ok((sc['linesAdded'] as number) >= 2);
    assert.ok((sc['linesRemoved'] as number) >= 2);

    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    assert.equal(results[0]?.['path'], 'alpha.txt');
    assert.equal(results[1]?.['path'], 'beta.txt');

    const alphaResult = results.find((r) => r['path'] === 'alpha.txt');
    assert.ok(alphaResult, 'Expected result for alpha.txt');
    assert.equal(alphaResult['applied'], true);
    assert.equal(alphaResult['hunksApplied'], 1);

    const betaResult = results.find((r) => r['path'] === 'beta.txt');
    assert.ok(betaResult, 'Expected result for beta.txt');
    assert.equal(betaResult['applied'], true);
    assert.equal(betaResult['hunksApplied'], 1);

    const actualA = await readFile(fileA, 'utf8');
    assert.ok(actualA.includes('TWO'), 'alpha.txt should contain TWO');
    assert.ok(!actualA.includes('\ntwo\n'), 'alpha.txt original "two" gone');

    const actualB = await readFile(fileB, 'utf8');
    assert.ok(
      actualB.includes('BBB_REPLACED'),
      'beta.txt should contain BBB_REPLACED'
    );
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

    // ok is false because not all files succeeded
    assert.equal(sc['ok'], false);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    assert.equal(results[0]?.['path'], 'alpha.txt');
    assert.equal(results[1]?.['path'], 'nonexistent.txt');

    const alphaResult = results.find((r) => r['path'] === 'alpha.txt');
    assert.ok(alphaResult);
    assert.equal(alphaResult['applied'], true);

    const missingResult = results.find((r) => r['path'] === 'nonexistent.txt');
    assert.ok(missingResult);
    assert.equal(missingResult['applied'], false);
    assert.ok(missingResult['error'], 'Expected error for missing file');
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
      name: 'read_many',
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
      const content = result['content'] as string;
      // Each file has 5 lines; tail=2 should return last 2
      assert.ok(!content.includes('1\n'), 'Should not include early lines');
    }

    const resultA = results.find((r) =>
      (r['path'] as string).includes('a.txt')
    );
    assert.ok(resultA);
    const contentA = resultA['content'] as string;
    assert.ok(contentA.includes('a4'), 'Should include a4');
    assert.ok(contentA.includes('a5'), 'Should include a5');

    const resultB = results.find((r) =>
      (r['path'] as string).includes('b.txt')
    );
    assert.ok(resultB);
    const contentB = resultB['content'] as string;
    assert.ok(contentB.includes('b4'), 'Should include b4');
    assert.ok(contentB.includes('b5'), 'Should include b5');
  });

  it('rejects tail combined with head in read_many', async () => {
    const raw = await env.client.callTool({
      name: 'read_many',
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
        'utf8'
      );
    }
  });

  after(async () => {
    await env.cleanup();
  });

  it('externalizes large grep results and includes resourceUri', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: {
        path: env.tmpDir,
        pattern: 'FINDME_marker',
        filePattern: '**/*.txt',
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true);

    const totalMatches = sc['totalMatches'] as number;
    assert.ok(totalMatches >= 50, `Expected >=50 matches, got ${totalMatches}`);

    // When externalized, resourceUri should be present
    if (sc['resourceUri']) {
      const resourceUri = sc['resourceUri'] as string;
      assert.ok(
        resourceUri.startsWith('filesystem-mcp://result/'),
        'resourceUri should point to result store'
      );
      assert.equal(
        sc['truncated'],
        true,
        'Should be truncated when externalized'
      );

      // Verify the resource_link content block includes expiresAt
      const result = raw as Record<string, unknown>;
      const content = result['content'] as Record<string, unknown>[];
      const resourceLink = content.find(
        (block) => block['type'] === 'resource_link'
      );
      assert.ok(resourceLink, 'Expected a resource_link content block');
      const description = resourceLink['description'] as string;
      assert.ok(
        description.includes('Expires:'),
        `resource_link description should include "Expires:": ${description}`
      );
    }
  });
});
