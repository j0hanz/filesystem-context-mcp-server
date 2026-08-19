/**
 * find_files: offset-cursor pagination and the name/path sortBy enum.
 *
 * Guards the search-files schema change (removed size/modified output fields,
 * sortBy narrowed to name|path) and the offset-cursor paging contract.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

describe('find_files — pagination', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await mkdir(join(env.tmpDir, 'sub'), { recursive: true });
    // Create 5 files across root + sub so both sortBy modes are distinguishable.
    await writeFile(join(env.tmpDir, 'a.txt'), 'x');
    await writeFile(join(env.tmpDir, 'b.txt'), 'x');
    await writeFile(join(env.tmpDir, 'c.txt'), 'x');
    await writeFile(join(env.tmpDir, 'sub', 'd.txt'), 'x');
    await writeFile(join(env.tmpDir, 'sub', 'e.txt'), 'x');
  });

  after(async () => {
    await env.cleanup();
  });

  it('paginates with an offset cursor and a stable second page', async () => {
    const page1 = await env.client.callTool({
      name: 'find_files',
      arguments: { path: env.tmpDir, pattern: '**/*.txt', maxResults: 2, sortBy: 'path' },
    });
    assertOk(page1);
    const s1 = getStructured<{ results: { path: string }[]; nextCursor?: string }>(page1);
    assert.equal(s1.results.length, 2);
    assert.ok(s1.nextCursor, 'first page must yield a nextCursor when truncated');

    const page2 = await env.client.callTool({
      name: 'find_files',
      arguments: {
        path: env.tmpDir,
        pattern: '**/*.txt',
        maxResults: 2,
        sortBy: 'path',
        cursor: s1.nextCursor,
      },
    });
    assertOk(page2);
    const s2 = getStructured<{ results: { path: string }[]; nextCursor?: string }>(page2);
    assert.equal(s2.results.length, 2);

    // Pages must not overlap.
    const p1 = (s1.results as { path: string }[]).map((r) => r.path);
    const p2 = (s2.results as { path: string }[]).map((r) => r.path);
    for (const p of p2) {
      assert.ok(!p1.includes(p), `page overlap on ${p}`);
    }

    // Third page drains the remainder.
    assert.ok(s2.nextCursor, 'second page must yield a nextCursor');
    const page3 = await env.client.callTool({
      name: 'find_files',
      arguments: {
        path: env.tmpDir,
        pattern: '**/*.txt',
        maxResults: 2,
        sortBy: 'path',
        cursor: s2.nextCursor,
      },
    });
    assertOk(page3);
    const s3 = getStructured<{ results: { path: string }[]; nextCursor?: string }>(page3);
    assert.equal(s3.results.length, 1);
    assert.equal(s3.nextCursor, undefined);
  });

  it('sortBy=name orders by basename', async () => {
    const res = await env.client.callTool({
      name: 'find_files',
      arguments: { path: env.tmpDir, pattern: '**/*.txt', maxResults: 10, sortBy: 'name' },
    });
    assertOk(res);
    const s = getStructured<{ results: { path: string }[] }>(res);
    const names = (s.results as { path: string }[]).map((r) => r.path.split('/').pop());
    // Basenames a,b,c,d,e — alphabetical by name regardless of directory.
    assert.deepEqual(names, ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  });
});
