import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';

import { PathCompleter } from '../../src/core/path-completer.js';
import { normalizePath, PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';

async function withTestDir(fn: (tmpDir: string) => Promise<void>) {
  const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-pathcomp-${randomUUID().slice(0, 8)}-`));
  try {
    await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

test('path-completer', async (t) => {
  await t.test('returns allowed directories on empty input without context', async () => {
    await withTestDir(async (tmpDir) => {
      const pathGuard = new PathGuard();
      const state = await resolveAllowedDirectoriesState([tmpDir]);
      pathGuard.initialize(state);

      const completer = new PathCompleter(pathGuard);
      const results = await completer.suggest('');

      assert.deepEqual(results, [normalizePath(tmpDir)]);
    });
  });

  await t.test('matches files inside directory', async () => {
    await withTestDir(async (tmpDir) => {
      await writeFile(join(tmpDir, 'file1.txt'), 'hello');
      await writeFile(join(tmpDir, 'file2.txt'), 'hello');
      await mkdir(join(tmpDir, 'subdir'));

      const pathGuard = new PathGuard();
      const state = await resolveAllowedDirectoriesState([tmpDir]);
      pathGuard.initialize(state);

      const completer = new PathCompleter(pathGuard);
      const results = await completer.suggest(tmpDir + sep + 'file');

      assert.deepEqual(results, [
        normalizePath(join(tmpDir, 'file1.txt')),
        normalizePath(join(tmpDir, 'file2.txt')),
      ]);

      const subdirResults = await completer.suggest(tmpDir + sep + 'sub');
      assert.deepEqual(subdirResults, [normalizePath(join(tmpDir, 'subdir')) + sep]);
    });
  });

  await t.test('uses context base directory when input is empty', async () => {
    await withTestDir(async (tmpDir) => {
      const srcDir = join(tmpDir, 'src');
      await mkdir(srcDir);
      await writeFile(join(srcDir, 'index.ts'), 'content');

      const pathGuard = new PathGuard();
      const state = await resolveAllowedDirectoriesState([tmpDir]);
      pathGuard.initialize(state);

      const completer = new PathCompleter(pathGuard);
      const results = await completer.suggest('', 'path', { path: srcDir + sep + 'index.ts' });

      assert.deepEqual(results, [normalizePath(join(srcDir, 'index.ts'))]);
    });
  });

  await t.test('matches named root input', async () => {
    await withTestDir(async (tmpDir) => {
      const namedRoot = join(tmpDir, 'myRoot');
      await mkdir(namedRoot);
      await writeFile(join(namedRoot, 'test.txt'), 'hello');

      const pathGuard = new PathGuard();
      const state = await resolveAllowedDirectoriesState([namedRoot]);
      pathGuard.initialize(state);

      const completer = new PathCompleter(pathGuard);
      const results = await completer.suggest('myRoot/test');

      assert.deepEqual(results, [normalizePath(join(namedRoot, 'test.txt'))]);
    });
  });

  // ─── REQ-003: Sensitive files must not appear in completion suggestions ───────

  await t.test('omits sensitive files from completion suggestions', async () => {
    await withTestDir(async (tmpDir) => {
      await writeFile(join(tmpDir, '.env'), 'SECRET=1');
      await writeFile(join(tmpDir, 'normal.txt'), 'hello');

      const pathGuard = new PathGuard();
      const state = await resolveAllowedDirectoriesState([tmpDir]);
      pathGuard.initialize(state);

      const completer = new PathCompleter(pathGuard);
      const results = await completer.suggest(tmpDir + sep);

      assert.ok(
        !results.some((r) => r.includes('.env')),
        `sensitive .env must not appear in suggestions, got: ${results.join(', ')}`,
      );
      assert.ok(
        results.some((r) => r.includes('normal.txt')),
        'normal.txt must appear in suggestions',
      );
    });
  });
});
