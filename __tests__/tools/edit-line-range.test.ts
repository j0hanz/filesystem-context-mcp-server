/**
 * edit: lineRange correctness (computeChangedLineRange) and first-match pin.
 *
 * Guards the #20 change: lineRange is computed against the FINAL content via a
 * common-prefix/suffix scan, and a single oldText match pins to the first
 * occurrence (indexOf / first exec) rather than replacing all.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

describe('edit — lineRange and first-match pin', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('reports a 1-indexed lineRange covering the changed line', async () => {
    const file = join(env.tmpDir, 'lines.txt');
    // 5 lines; the edit targets line 3 (1-indexed).
    await writeFile(file, 'alpha\nbeta\ngamma\ndelta\nepsilon\n');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'gamma', newText: 'GAMMA' }],
      },
    });
    assertOk(res);
    const s = getStructured<{
      results: { value?: { appliedEdits: number; lineRange?: [number, number] } }[];
    }>(res);
    const value = s.results[0]?.value;
    assert.ok(value);
    assert.equal(value.appliedEdits, 1);
    assert.deepEqual(value.lineRange, [3, 3]);

    const after = await readFile(file, 'utf8');
    assert.equal(after, 'alpha\nbeta\nGAMMA\ndelta\nepsilon\n');
  });

  it('pins a replacement to the first match when oldText occurs twice', async () => {
    const file = join(env.tmpDir, 'dup.txt');
    await writeFile(file, 'token\ntoken\n');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'token', newText: 'first' }],
      },
    });
    assertOk(res);
    const s = getStructured<{
      results: { value?: { appliedEdits: number; lineRange?: [number, number] } }[];
    }>(res);
    assert.equal(s.results[0]?.value?.appliedEdits, 1);

    const after = await readFile(file, 'utf8');
    // Only the first occurrence replaced; the second survives.
    assert.equal(after, 'first\ntoken\n');
  });
});
