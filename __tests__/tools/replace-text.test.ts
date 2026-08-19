/**
 * replace_text: happy path, no-match (still ok), and regex-rejection failure.
 *
 * Guards the replace-in-files bookkeeping (#5/#22: failures recorded with
 * toPosixRelative, no glob followSymlinks/stats flags) and the shared
 * assertSafeRegex rejection path.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

describe('replace_text — happy / no-match / failure', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies a literal replacement and reports counts', async () => {
    const file = join(env.tmpDir, 'r.txt');
    await writeFile(file, 'foo bar foo baz\n');

    const res = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: env.tmpDir,
        pattern: 'r.txt',
        searchPattern: 'foo',
        replacement: 'qux',
      },
    });
    assertOk(res);
    const s = getStructured<{ filesModified: number; totalMatches: number }>(res);
    assert.equal(s.filesModified, 1);
    assert.equal(s.totalMatches, 2);

    const after = await readFile(file, 'utf8');
    assert.equal(after, 'qux bar qux baz\n');
  });

  it('no-match reports zero counts without erroring', async () => {
    const file = join(env.tmpDir, 'nomatch.txt');
    await writeFile(file, 'nothing here\n');

    const res = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: env.tmpDir,
        pattern: 'nomatch.txt',
        searchPattern: 'zzz',
        replacement: 'qqq',
      },
    });
    assertOk(res);
    const s = getStructured<{ filesModified: number; totalMatches: number }>(res);
    assert.equal(s.filesModified, 0);
    assert.equal(s.totalMatches, 0);
  });

  it('rejects a lookahead regex as a tool error', async () => {
    const res = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
        searchPattern: 'a(?=b)',
        replacement: 'c',
        isRegex: true,
      },
    });
    assertToolError(res);
  });
});
