import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchContent } from '../../../lib/file-operations/search/engine.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

function registerSearchContentEdgeBasics(getTestDir: () => string): void {
  void it('searchContent handles empty search results', async () => {
    const result = await searchContent(getTestDir(), 'xyznonexistent123', {
      filePattern: '**/*.ts',
    });
    assert.strictEqual(result.matches.length, 0);
    assert.strictEqual(result.summary.filesMatched, 0);
  });

  void it('searchContent handles special regex characters safely', async () => {
    const result = await searchContent(getTestDir(), 'hello\\.world', {
      filePattern: '**/*.ts',
    });
    assert.ok(result);
  });

  void it('searchContent throws on invalid regex syntax', async () => {
    await assert.rejects(
      searchContent(getTestDir(), '(?', { isLiteral: false }),
      /Invalid regular expression|ReDoS/i
    );
  });
}

function registerSearchContentEdgeLimits(getTestDir: () => string): void {
  void it('searchContent respects maxResults limit', async () => {
    const result = await searchContent(getTestDir(), 'export', {
      filePattern: '**/*.ts',
      maxResults: 1,
    });
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.summary.truncated, true);
    assert.strictEqual(result.summary.stoppedReason, 'maxResults');
  });

  void it('searchContent respects maxFilesScanned limit', async () => {
    const result = await searchContent(getTestDir(), 'export', {
      filePattern: '**/*',
      maxFilesScanned: 1,
    });
    assert.ok(result.summary.filesScanned <= 1);
  });
}

function registerSearchContentEdgeTimeouts(getTestDir: () => string): void {
  void it('searchContent handles timeout correctly', async () => {
    const result = await searchContent(getTestDir(), 'export', {
      filePattern: '**/*',
      timeoutMs: 10,
    });
    assert.ok(result);
  });

  void it('searchContent stops early when maxResults is 0', async () => {
    const result = await searchContent(getTestDir(), 'Line', {
      maxResults: 0,
    });
    assert.strictEqual(result.summary.truncated, true);
    assert.strictEqual(result.summary.stoppedReason, 'maxResults');
  });
}

function registerSearchContentEdgeLiteralMismatch(
  getTestDir: () => string
): void {
  void it('searchContent matches literal strings when isLiteral=true', async () => {
    const result = await searchContent(getTestDir(), 'Test.*Project', {
      isLiteral: true,
      filePattern: '**/*.md',
    });
    assert.strictEqual(result.matches.length, 0);
  });
}

function registerSearchContentEdgeLiteralEscaping(
  getTestDir: () => string
): void {
  void it('searchContent escapes regex metacharacters for case-insensitive literal matching', async () => {
    const token = 'A.*(B)[C]\\D?+^${}';
    const filePath = path.join(getTestDir(), 'literal-regex-metachars.txt');
    await fs.writeFile(filePath, `${token} ${token}\n`);

    const result = await searchContent(getTestDir(), token.toLowerCase(), {
      isLiteral: true,
      filePattern: '**/*.txt',
    });

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0]?.matchCount, 2);
    await fs.rm(filePath).catch(() => {});
  });
}

void describe('searchContent edge cases', () => {
  withFileOpsFixture((getTestDir) => {
    registerSearchContentEdgeBasics(getTestDir);
    registerSearchContentEdgeLimits(getTestDir);
    registerSearchContentEdgeTimeouts(getTestDir);
    registerSearchContentEdgeLiteralMismatch(getTestDir);
    registerSearchContentEdgeLiteralEscaping(getTestDir);
  });
});
