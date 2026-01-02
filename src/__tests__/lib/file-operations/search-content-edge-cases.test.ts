import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { searchContent } from '../../../lib/file-operations.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

void describe('searchContent edge cases', () => {
  withFileOpsFixture((getTestDir) => {
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
        searchContent(getTestDir(), '(?'),
        /Invalid regular expression|ReDoS/i
      );
    });

    void it('searchContent respects maxResults limit', async () => {
      const result = await searchContent(getTestDir(), '\\w+', {
        filePattern: '**/*.ts',
        maxResults: 1,
      });
      assert.ok(result.matches.length <= 1);
      if (result.matches.length === 1) {
        assert.strictEqual(result.summary.truncated, true);
      }
    });

    void it('searchContent respects maxFilesScanned limit', async () => {
      const result = await searchContent(getTestDir(), 'export', {
        filePattern: '**/*',
        maxFilesScanned: 1,
      });
      assert.ok(result.summary.filesScanned <= 1);
    });

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

    void it('searchContent matches literal strings when isLiteral=true', async () => {
      const result = await searchContent(getTestDir(), 'Test.*Project', {
        isLiteral: true,
        filePattern: '**/*.md',
      });
      assert.strictEqual(result.matches.length, 0);
    });
  });
});
