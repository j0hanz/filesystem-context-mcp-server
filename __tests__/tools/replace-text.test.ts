/**
 * replace_text: happy path, no-match (still ok), and regex-rejection failure.
 *
 * Guards the replace-in-files bookkeeping (#5/#22: failures recorded with
 * toPosixRelative, no glob followSymlinks/stats flags) and the shared
 * assertSafeRegex rejection path.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

describe('replace_text — gitignore and single-file targeting', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('skips a gitignored file by default and rewrites it with includeIgnored', async () => {
    const dir = join(env.tmpDir, 'git-test');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'ignored.txt\n');
    const file = join(dir, 'ignored.txt');
    await writeFile(file, 'MARKER content\n');

    // Default args → respectGitignore: true → the gitignored file is untouched.
    let res = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: dir,
        pattern: '**/*',
        searchPattern: 'MARKER',
        replacement: 'DONE',
      },
    });
    assertOk(res);
    let s = getStructured<{ filesModified: number }>(res);
    assert.equal(s.filesModified, 0, 'gitignored file must be skipped by default');
    assert.equal(await readFile(file, 'utf8'), 'MARKER content\n');

    // includeIgnored bypasses gitignore → the file is rewritten.
    res = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: dir,
        pattern: '**/*',
        searchPattern: 'MARKER',
        replacement: 'DONE',
        includeIgnored: true,
      },
    });
    assertOk(res);
    s = getStructured<{ filesModified: number }>(res);
    assert.equal(s.filesModified, 1, 'includeIgnored must rewrite the gitignored file');
    assert.equal(await readFile(file, 'utf8'), 'DONE content\n');
  });

  it('targets only the named file, not same-named siblings', async () => {
    const a = join(env.tmpDir, 'a');
    const b = join(env.tmpDir, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const aFoo = join(a, 'foo.txt');
    const bFoo = join(b, 'foo.txt');
    await writeFile(aFoo, 'TARGET line\n');
    await writeFile(bFoo, 'TARGET line\n');

    const res = await env.client.callTool({
      name: 'replace_text',
      arguments: {
        path: aFoo,
        searchPattern: 'TARGET',
        replacement: 'DONE',
      },
    });
    assertOk(res);
    const s = getStructured<{ filesModified: number }>(res);
    assert.equal(s.filesModified, 1, 'only the explicitly named file must be modified');
    assert.equal(await readFile(aFoo, 'utf8'), 'DONE line\n');
    assert.equal(
      await readFile(bFoo, 'utf8'),
      'TARGET line\n',
      'same-named sibling must be untouched',
    );
  });
});
