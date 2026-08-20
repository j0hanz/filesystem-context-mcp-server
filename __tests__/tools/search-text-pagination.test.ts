/**
 * search_text: offset-cursor pagination and regex-rejection failures.
 *
 * Guards the #4 change (assertSafeRegex rejects lookahead/lookbehind/backrefs)
 * and the offset-cursor paging contract for content search.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { encodeOffsetCursor } from '../../src/core/cursor.js';
import { MAX_SEARCH_RESULTS } from '../../src/core/util.js';
import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

describe('search_text — pagination and regex failures', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    // 5 matching lines so a maxResults=2 page yields 3 pages (2,2,1) with no
    // boundary overshoot: an exact-cap page would emit a stale nextCursor.
    const body = Array.from({ length: 5 }, (_, i) => `marker line ${i}`).join('\n') + '\n';
    await writeFile(join(env.tmpDir, 'hay.txt'), body);
  });

  after(async () => {
    await env.cleanup();
  });

  const search = async (args: Record<string, unknown>) =>
    env.client.callTool({ name: 'search_text', arguments: { path: env.tmpDir, ...args } });

  it('paginates matches across pages via cursor', async () => {
    const p1 = await search({ searchPattern: 'marker', maxResults: 2 });
    assertOk(p1);
    const s1 = getStructured<{ matches: unknown[]; nextCursor?: string }>(p1);
    assert.equal(s1.matches.length, 2);
    assert.ok(s1.nextCursor);

    const p2 = await search({ searchPattern: 'marker', maxResults: 2, cursor: s1.nextCursor });
    assertOk(p2);
    const s2 = getStructured<{ matches: unknown[]; nextCursor?: string }>(p2);
    assert.equal(s2.matches.length, 2);
    assert.ok(s2.nextCursor);

    const p3 = await search({ searchPattern: 'marker', maxResults: 2, cursor: s2.nextCursor });
    assertOk(p3);
    const s3 = getStructured<{ matches: unknown[]; nextCursor?: string }>(p3);
    assert.equal(s3.matches.length, 1);
    assert.equal(s3.nextCursor, undefined);
  });

  it('rejects a lookahead regex as a tool error', async () => {
    const res = await search({ searchPattern: 'foo(?=bar)', isRegex: true });
    assertToolError(res);
  });

  it('rejects a backreference regex as a tool error', async () => {
    const res = await search({ searchPattern: '(a)\\1', isRegex: true });
    assertToolError(res);
  });

  it('rejects an empty searchPattern as a tool error', async () => {
    const res = await search({ searchPattern: '   ' });
    assertToolError(res);
  });

  it('clamps a huge cursor so the scan does not collect past the result cap', async () => {
    // More than MAX_SEARCH_RESULTS matching lines so an unclamped fetchMax
    // (cursorOffset + pageSize) would collect past the cap. The clamp holds
    // fetchMax at MAX_SEARCH_RESULTS, so totalMatches cannot exceed it.
    const body =
      Array.from({ length: MAX_SEARCH_RESULTS + 1 }, (_, i) => `marker line ${i}`).join('\n') +
      '\n';
    await writeFile(join(env.tmpDir, 'big.txt'), body);

    const res = await search({
      searchPattern: 'marker',
      maxResults: 5,
      cursor: encodeOffsetCursor(MAX_SEARCH_RESULTS * 5),
    });
    assertOk(res);
    const s = getStructured<{ matches: unknown[]; totalMatches?: number }>(res);
    // Offset (50000) is far past the cap, so the page is empty; the guard is the
    // summary count. Without the clamp totalMatches would be 10000+ here.
    assert.ok((s.totalMatches ?? 0) <= MAX_SEARCH_RESULTS);
  });
});
