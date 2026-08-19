/**
 * search_text: totalMatches vs per-entry matchCount units.
 *
 * `totalMatches` counts matching LINES (one per entry in `matches`), while a
 * match entry's `matchCount` counts pattern OCCURRENCES on that line. Guards
 * against the two being conflated — totalMatches is what `matches.length` is
 * compared against for pagination, so it must stay a line count.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestEnv, getStructured, type TestEnv } from '../helpers.js';

interface SearchStructured {
  matches: { content: string; matchCount?: number }[];
  totalMatches?: number;
  filesMatched?: number;
}

describe('search_text — totalMatches counts lines, matchCount counts occurrences', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    // One line with three occurrences, one line with a single occurrence.
    await writeFile(join(env.tmpDir, 'counts.txt'), 'TODO a TODO b TODO\nplain\nTODO c\n');
  });

  after(async () => {
    await env.cleanup();
  });

  const search = async (args: Record<string, unknown>): Promise<SearchStructured> => {
    const raw = await env.client.callTool({
      name: 'search_text',
      arguments: { path: env.tmpDir, ...args },
    });
    return getStructured<SearchStructured>(raw);
  };

  it('reports one entry per matching line with its own occurrence count', async () => {
    const result = await search({ searchPattern: 'TODO' });

    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0]?.matchCount, 3);
    assert.equal(result.matches[1]?.matchCount, 1);
  });

  it('totalMatches equals the matching-line count, not the occurrence total', async () => {
    const result = await search({ searchPattern: 'TODO' });

    assert.equal(result.totalMatches, 2);
    assert.equal(result.totalMatches, result.matches.length);
    assert.equal(result.filesMatched, 1);
  });
});
