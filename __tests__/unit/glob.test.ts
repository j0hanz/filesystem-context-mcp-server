import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, test } from 'node:test';

import {
  buildHiddenPatterns,
  globEntries,
  isIgnoredByGitignore,
  loadRootGitignore,
} from '../../src/core/glob.js';

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

test('buildHiddenPatterns covers a trailing bare ** (src/**, **)', () => {
  // A trailing bare globstar — `src/**`, `**` — is its own case: it has no
  // following segment, so the `**/`-prefixed branch never fires. Without a
  // dedicated branch the only pattern is the original and hidden entries are
  // silently dropped.
  for (const input of ['**', 'src/**']) {
    const patterns = buildHiddenPatterns(input, 100);
    const star = input === '**' ? '' : 'src/';
    assert.ok(
      patterns.some((p) => p === `${star}**/.*`),
      `${input}: missing dotfile/dotdir pattern in ${JSON.stringify(patterns)}`,
    );
    assert.ok(
      patterns.some((p) => p === `${star}**/.*/**`),
      `${input}: missing dotdir-contents pattern in ${JSON.stringify(patterns)}`,
    );
  }
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

test('globEntries with a trailing bare ** and includeHidden finds dotfiles', async () => {
  // `**` and `src/**` have no segment after the globstar; the dedicated branch
  // must add the hidden complements or dotfiles are omitted.
  const paths: string[] = [];
  for await (const entry of globEntries({
    cwd: root,
    pattern: '**',
    includeHidden: true,
    onlyFiles: true,
    maxDepth: 100,
  })) {
    paths.push(entry.path);
  }
  const rootPosix = root.replace(/\\/g, '/');
  const found = paths.map((p) => p.replace(/\\/g, '/').replace(rootPosix, '').replace(/^\/+/, ''));
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

describe('GitignoreManager (nested gitignore support test setup)', () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), `fsmcp-sfh-test-${randomUUID().slice(0, 8)}-`));

    // Create a directory structure with nested .gitignore files
    await writeFile(
      join(tempDir, '.gitignore'),
      `
*.log
!important.log
/sub_ignored/
`,
    );

    await mkdir(join(tempDir, 'sub_ignored'));
    await writeFile(join(tempDir, 'sub_ignored', 'nested.txt'), 'content');

    await mkdir(join(tempDir, 'sub'));
    await writeFile(
      join(tempDir, 'sub', '.gitignore'),
      `
*.txt
!special.txt
`,
    );
    await writeFile(join(tempDir, 'sub', 'nested.txt'), 'content');
    await writeFile(join(tempDir, 'sub', 'special.txt'), 'content');
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });
  describe('GitignoreManager (nested gitignore support)', () => {
    it('properly loads nested gitignores and evaluates them correctly', async () => {
      const manager = await loadRootGitignore(tempDir);
      assert.notEqual(manager, null);
      if (!manager) return;

      // 1. Root level ignores
      assert.equal(isIgnoredByGitignore(manager, tempDir, join(tempDir, 'test.log')), true);
      assert.equal(isIgnoredByGitignore(manager, tempDir, join(tempDir, 'important.log')), false);

      // 2. Directory exclusion (sub_ignored/ is ignored, everything inside it should be ignored)
      assert.equal(
        isIgnoredByGitignore(manager, tempDir, join(tempDir, 'sub_ignored', 'nested.txt')),
        true,
      );

      // 3. Nested gitignores (sub/ ignores *.txt but unignores special.txt)
      assert.equal(
        isIgnoredByGitignore(manager, tempDir, join(tempDir, 'sub', 'nested.txt'), {
          isDirectory: false,
        }),
        true,
      );
      assert.equal(
        isIgnoredByGitignore(manager, tempDir, join(tempDir, 'sub', 'special.txt'), {
          isDirectory: false,
        }),
        false,
      );
    });
  });
});
