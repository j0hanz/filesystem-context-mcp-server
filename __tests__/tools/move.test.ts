/**
 * Integration tests for the move tool.
 */
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  createTestEnv,
  createTestEnvWithElicitation,
  getStructured,
  type TestEnv,
} from '../helpers.js';

describe('move tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('rejects moving directory into case-variant subdirectory on case-insensitive systems', async () => {
    const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    if (!isCaseInsensitive) {
      return; // Skip on case-sensitive systems (or adapt test)
    }

    const sourceDir = join(env.tmpDir, 'MySource');
    const targetInSource = join(env.tmpDir, 'mysource', 'nested'); // Case variant 'mysource' vs 'MySource'

    await mkdir(sourceDir, { recursive: true });

    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        moves: [
          {
            source: sourceDir,
            destination: targetInSource,
          },
        ],
      },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    const failures = sc['failures'] as { error: { code: string; message: string } }[];
    assert.ok(Array.isArray(failures));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].error.code, 'INVALID_INPUT');
    assert.match(failures[0].error.message, /subdirectory/);
  });

  it('performs a case-only rename with no overwrite confirmation on darwin', async () => {
    // Genuine case-only rename (Foo.txt -> foo.txt): isSamePath must treat the
    // two as the same path so move skips the overwrite-confirmation elicit. The
    // darwin fold landed in Step 11; before it, isSamePath was Windows-only.
    //
    // Gated to darwin only: on win32 the move tool no-ops a case-only rename —
    // move.ts:248 resolves the destination to the source's actual on-disk
    // casing, so `resolvedSource === resolvedDest` continues before any rename
    // (verified empirically: `moves: []`, no failure). That no-op is pre-existing
    // move.ts behavior, out of Step 11's scope (no move.ts change). CI has no
    // macOS runner (ci.yml runs ubuntu/windows only), so this self-verifies on a
    // real Mac locally; the win32 leg is covered by the case-variant test above.
    if (process.platform !== 'darwin') return;

    const e = await createTestEnvWithElicitation(async () => {
      assert.fail('overwrite confirmation must not elicit for a case-only rename');
    });
    try {
      const src = join(e.tmpDir, 'Foo.txt');
      await writeFile(src, 'content');
      const dest = join(e.tmpDir, 'foo.txt');

      const raw = await e.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dest }] },
      });
      assertOk(raw);
      const sc = getStructured(raw);
      assert.equal(sc['ok'], true);
      const moves = sc['moves'] as { ok: boolean }[];
      assert.equal(moves.length, 1, 'must be a single rename, not an overwrite flow');

      const entries = await readdir(e.tmpDir);
      assert.ok(entries.includes('foo.txt'), 'file must be renamed to lowercase on disk');
      assert.ok(!entries.includes('Foo.txt'), 'original casing must be gone');
    } finally {
      await e.cleanup();
    }
  });
});
