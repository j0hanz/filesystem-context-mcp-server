import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { buildHiddenPatterns, globEntries } from '../../src/core/glob.js';

test('buildHiddenPatterns is bounded regardless of maxDepth (no per-depth unroll)', () => {
  // The search default is maxDepth 100; previously this yielded ~200 patterns.
  const patterns = buildHiddenPatterns('**/*', 100);
  assert.ok(
    patterns.length <= 8,
    `expected <= 8 hidden patterns, got ${patterns.length}: ${JSON.stringify(patterns)}`,
  );
  // Must contain the depth-agnostic dotfile + dotdir-content forms.
  assert.ok(patterns.some((p) => p.includes('**/.*')));
  assert.ok(patterns.some((p) => p.includes('**/.*/**')));
});

let root: string;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'glob-hidden-'));
  await mkdir(join(root, '.hidden'), { recursive: true });
  await mkdir(join(root, 'sub', '.deep'), { recursive: true });
  await writeFile(join(root, '.env'), 'x');
  await writeFile(join(root, '.hidden', 'f.txt'), 'x');
  await writeFile(join(root, 'sub', '.deep', 'g.txt'), 'x');
  await writeFile(join(root, 'sub', 'normal.txt'), 'x');
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

test('globEntries with includeHidden finds dotfiles at multiple depths', async () => {
  const paths: string[] = [];
  for await (const entry of globEntries({
    cwd: root,
    pattern: '**/*',
    includeHidden: true,
    onlyFiles: true,
    maxDepth: 100,
  })) {
    paths.push(entry.path);
  }
  const rootPosix = root.replace(/\\/g, '/');
  const rel = (p: string) => p.replace(/\\/g, '/').replace(rootPosix, '').replace(/^\/+/, '');
  const found = paths.map(rel);
  assert.ok(found.includes('.env'), `missing root dotfile; found ${JSON.stringify(found)}`);
  assert.ok(
    found.some((p) => p.endsWith('.hidden/f.txt')),
    `missing depth-1 dotdir file; found ${JSON.stringify(found)}`,
  );
  assert.ok(
    found.some((p) => p.endsWith('.deep/g.txt')),
    `missing depth-2 dotdir file; found ${JSON.stringify(found)}`,
  );
});
