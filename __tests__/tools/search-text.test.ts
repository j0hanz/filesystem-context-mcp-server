/**
 * search_text: literal vs regex matching.
 *
 * Guards the isRegex wiring — the tool used to send an `isLiteral` flag the
 * engine never read, so `isRegex: true` silently fell back to literal search.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestEnv, getStructured, type TestEnv } from '../helpers.js';

describe('search_text — literal vs regex', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'a.txt'), 'function alpha(\nfunction beta(\nliteral a.c\n');
  });

  after(async () => {
    await env.cleanup();
  });

  const search = async (args: Record<string, unknown>) => {
    const raw = await env.client.callTool({
      name: 'search_text',
      arguments: { path: env.tmpDir, ...args },
    });
    return getStructured<{ matches: { content: string }[] }>(raw);
  };

  it('isRegex=true applies the pattern as a regex', async () => {
    const result = await search({ searchPattern: 'function\\s+\\w+\\(', isRegex: true });
    assert.equal(result.matches.length, 2);
  });

  it('isRegex=false (default) treats metacharacters literally', async () => {
    // "a.c" as a regex would also match "alpha(" ... it does not here.
    const result = await search({ searchPattern: 'a.c' });
    assert.equal(result.matches.length, 1);
    assert.ok(result.matches[0]?.content.includes('literal a.c'));
  });

  it('a regex pattern sent without isRegex finds nothing', async () => {
    const result = await search({ searchPattern: 'function\\s+\\w+\\(' });
    assert.equal(result.matches.length, 0);
  });

  it('calculates column offset accurately for case-insensitive literal search with Unicode', async () => {
    const file = join(env.tmpDir, 'unicode.txt');
    await writeFile(file, '\u0130 target_word\n');

    const raw = await env.client.callTool({
      name: 'search_text',
      arguments: { path: env.tmpDir, pattern: 'unicode.txt', searchPattern: 'TARGET_WORD' },
    });
    const s = getStructured<{ matches: { column?: number; content: string }[] }>(raw);
    assert.equal(s.matches.length, 1);
    // "\u0130 target_word" -> "\u0130" is 1 UTF-16 code unit, space is 1 code unit, target_word starts at index 2
    assert.equal(s.matches[0]?.column, 2);
  });
});
