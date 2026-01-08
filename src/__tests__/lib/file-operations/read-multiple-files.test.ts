import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readMultipleFiles } from '../../../lib/file-operations/read-multiple-files.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

function registerReadMultipleBasics(getTestDir: () => string): void {
  void it('readMultipleFiles reads multiple files in parallel', async () => {
    const paths = [
      path.join(getTestDir(), 'README.md'),
      path.join(getTestDir(), 'src', 'index.ts'),
    ];
    const results = await readMultipleFiles(paths);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(
      results.every((r) => r.content !== undefined),
      true
    );
  });

  void it('readMultipleFiles handles individual file errors gracefully', async () => {
    const paths = [
      path.join(getTestDir(), 'README.md'),
      path.join(getTestDir(), 'non-existent.txt'),
    ];
    const results = await readMultipleFiles(paths);
    assert.strictEqual(results.length, 2);
    assert.ok(results[0]?.content);
    assert.ok(results[1]?.error);
  });
}

function registerReadMultipleDuplicates(getTestDir: () => string): void {
  void it('readMultipleFiles preserves requested paths for duplicates', async () => {
    const filePath = path.join(getTestDir(), 'README.md');
    const results = await readMultipleFiles([filePath, filePath]);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0]?.path, filePath);
    assert.strictEqual(results[1]?.path, filePath);
  });
}

function registerReadMultipleLimits(getTestDir: () => string): void {
  void it('readMultipleFiles enforces total size cap for head reads', async () => {
    const big1 = path.join(getTestDir(), 'big1.log');
    const big2 = path.join(getTestDir(), 'big2.log');
    const largeContent = 'A'.repeat(50_000);
    await fs.writeFile(big1, largeContent);
    await fs.writeFile(big2, largeContent);

    const results = await readMultipleFiles([big1, big2], {
      head: 1,
      maxTotalSize: 10,
    });

    assert.strictEqual(
      results.every((r) => r.error !== undefined),
      true
    );
    await Promise.all([fs.rm(big1), fs.rm(big2)]).catch(() => {});
  });

  void it('readMultipleFiles supports head parameter', async () => {
    const filePath = path.join(getTestDir(), 'multiline.txt');
    const results = await readMultipleFiles([filePath], { head: 5 });

    const content = results[0].content ?? '';
    assert.ok(content.includes('Line 1'));
    assert.ok(content.includes('Line 5'));
    assert.strictEqual(results[0].truncated, true);
    assert.strictEqual(results[0].readMode, 'head');
  });
}

void describe('readMultipleFiles', () => {
  withFileOpsFixture((getTestDir) => {
    registerReadMultipleBasics(getTestDir);
    registerReadMultipleDuplicates(getTestDir);
    registerReadMultipleLimits(getTestDir);
  });
});
