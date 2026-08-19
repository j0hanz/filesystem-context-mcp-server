/**
 * read: tail across the 64KB chunk boundary.
 *
 * readTailContent walks the file backwards in 64KB chunks. The oldest chunk it
 * reads starts mid-line whenever it stops before the file start, so that
 * leading fragment must be dropped rather than returned as a whole line.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

const CHUNK_SIZE = 64 * 1024;

describe('read — tail across the chunk boundary', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('never returns a line truncated by the chunk boundary', async () => {
    const file = join(env.tmpDir, 'long-line.txt');
    // The last 64KB starts inside `long`, and holds exactly two newlines: the
    // one ending `long` and the one ending `zz`. Requesting tail=2 must not
    // report the readable fragment of `long` as the whole line.
    const long = 'A'.repeat(CHUNK_SIZE + 4464);
    await writeFile(file, `first\n${long}\nzz\n`);

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 2 },
    });
    assertOk(raw);
    const sc = getStructured<{ results: { value?: { content?: string } }[] }>(raw);
    const content = sc.results[0]?.value?.content;
    assert.ok(content !== undefined);

    const lines: string[] = content.split('\n');
    assert.deepEqual(
      lines.map((l: string) => l.length),
      [long.length, 2],
    );
    assert.equal(lines[1], 'zz');
  });

  it('returns whole lines when the whole file fits in one chunk', async () => {
    const file = join(env.tmpDir, 'short.txt');
    await writeFile(file, 'alpha\nbeta\ngamma\n');

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 2 },
    });
    assertOk(raw);
    const sc = getStructured<{ results: { value?: { content?: string } }[] }>(raw);
    assert.equal(sc.results[0]?.value?.content, 'beta\ngamma');
  });

  it('returns the whole file when tail exceeds the line count', async () => {
    const file = join(env.tmpDir, 'tiny.txt');
    await writeFile(file, 'only\n');

    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, tail: 10 },
    });
    assertOk(raw);
    const sc = getStructured<{ results: { value?: { content?: string } }[] }>(raw);
    assert.equal(sc.results[0]?.value?.content, 'only');
  });
});
