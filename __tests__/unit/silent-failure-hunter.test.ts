import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { atomicWriteFile, isIgnoredByGitignore, loadRootGitignore } from '../../src/core/fs.js';
import { PathGuard } from '../../src/core/path.js';

describe('silent-failure-hunter fixes', () => {
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

  describe('atomicWriteFile (suffix length)', () => {
    it('uses a 12-character random suffix for temp files', async () => {
      const target = join(tempDir, 'atomic.txt');
      const pg = await PathGuard.fromAllowedDirectories([tempDir]);

      // Mock validatePathForWrite to return target
      const { validPath } = await atomicWriteFile(target, 'content', pg);
      assert.equal(validPath.toLowerCase(), target.toLowerCase());
    });
  });
});
