/**
 * Integration tests for the move tool.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

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
});
