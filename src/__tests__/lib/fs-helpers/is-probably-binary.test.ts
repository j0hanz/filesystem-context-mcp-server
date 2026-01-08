import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isProbablyBinary } from '../../../lib/fs-helpers/binary-detect.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

function registerBinaryBasics(getTestDir: () => string): void {
  void it('isProbablyBinary identifies binary files', async () => {
    const isBinary = await isProbablyBinary(
      path.join(getTestDir(), 'image.png')
    );
    assert.strictEqual(isBinary, true);
  });

  void it('isProbablyBinary identifies text files', async () => {
    const isBinary = await isProbablyBinary(
      path.join(getTestDir(), 'README.md')
    );
    assert.strictEqual(isBinary, false);
  });
}

function registerBinaryEdgeCases(getTestDir: () => string): void {
  void it('isProbablyBinary identifies empty files as text', async () => {
    const emptyFile = path.join(getTestDir(), 'empty.txt');
    await fs.writeFile(emptyFile, '');
    const isBinary = await isProbablyBinary(emptyFile);
    assert.strictEqual(isBinary, false);
    await fs.rm(emptyFile);
  });

  void it('isProbablyBinary identifies UTF-8 BOM files as text', async () => {
    const bomFile = path.join(getTestDir(), 'bom.txt');
    const content = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Hello World'),
    ]);
    await fs.writeFile(bomFile, content);
    const isBinary = await isProbablyBinary(bomFile);
    assert.strictEqual(isBinary, false);
    await fs.rm(bomFile);
  });
}

void describe('isProbablyBinary', () => {
  withFileOpsFixture((getTestDir) => {
    registerBinaryBasics(getTestDir);
    registerBinaryEdgeCases(getTestDir);
  });
});
