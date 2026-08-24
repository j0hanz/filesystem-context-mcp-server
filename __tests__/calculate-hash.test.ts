import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { isNodeError } from '../src/core/errors.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  type TestClientContext,
  writeTestFile,
} from './helpers.js';

describe('hash_file (directory)', () => {
  let root: string;
  let harness: TestClientContext;

  beforeEach(async () => {
    root = await createTestRoot();
    harness = await createTestClientPair([root]);
  });

  afterEach(async () => {
    if (harness) {
      await harness.close();
    }
    if (root) {
      await cleanupTestRoot(root);
    }
  });

  it('TC-HASH-001: symlink → sensitive file is skipped, directory still hashes', async (t) => {
    await writeTestFile(root, 'plain.txt', 'hello');
    await writeTestFile(root, '.env', 'SECRET=xyz');

    // Symlink link-to-env -> .env. The link's own name is innocuous; the
    // lexical isSensitive check would miss it and Phase 2 would throw on the
    // resolved .env target, aborting the whole directory hash.
    try {
      await symlink(join(root, '.env'), join(root, 'link-to-env'));
    } catch (err: unknown) {
      if (
        process.platform === 'win32' &&
        isNodeError(err) &&
        (err.code === 'EPERM' || err.code === 'EACCES')
      ) {
        t.skip?.('symlink creation requires admin/developer mode on Windows');
        return;
      }
      throw err;
    }

    const result = await harness.client.callTool({
      name: 'hash_file',
      arguments: { path: root },
    });

    assert.notStrictEqual(result.isError, true, 'directory hash must not abort');
    const structured = result.structuredContent as {
      ok: boolean;
      isDirectory: boolean;
      hashes: Record<string, string>;
      fileCount: number;
    };
    assert.strictEqual(structured.ok, true);
    assert.strictEqual(structured.isDirectory, true);
    assert.ok(structured.hashes.sha256, 'must return a composite digest');
    // Only plain.txt is hashed; .env and link-to-env are skipped.
    assert.strictEqual(
      structured.fileCount,
      1,
      'sensitive file and its symlink must be excluded from the file count',
    );
  });

  it('TC-HASH-002: a plain .env is still skipped (regression guard)', async () => {
    await writeTestFile(root, 'plain.txt', 'hello');
    await writeTestFile(root, '.env', 'SECRET=xyz');

    const result = await harness.client.callTool({
      name: 'hash_file',
      arguments: { path: root },
    });

    assert.notStrictEqual(result.isError, true, 'directory hash must not abort');
    const structured = result.structuredContent as {
      ok: boolean;
      isDirectory: boolean;
      hashes: Record<string, string>;
      fileCount: number;
    };
    assert.strictEqual(structured.ok, true);
    assert.strictEqual(structured.isDirectory, true);
    assert.ok(structured.hashes.sha256, 'must return a composite digest');
    assert.strictEqual(structured.fileCount, 1, '.env must be excluded');
  });
});
