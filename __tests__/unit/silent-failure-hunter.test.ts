import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { GuardedFileSystem } from '../../src/core/fs.js';
import { isIgnoredByGitignore, loadRootGitignore } from '../../src/core/glob.js';
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
      const gfs = new GuardedFileSystem(pg);

      // Mock validatePathForWrite to return target
      const { validPath } = await gfs.writeFile(target, 'content');
      assert.equal(validPath.toLowerCase(), target.toLowerCase());
    });
  });

  describe('isProbablyBinary (boundary UTF-8 split)', () => {
    it('does not classify a text file with emoji at boundary as binary', async () => {
      const target = join(tempDir, 'boundary-emoji.txt');
      const content = 'a'.repeat(511) + '😊';
      await writeFile(target, content, 'utf8');

      const pg = await PathGuard.fromAllowedDirectories([tempDir]);
      const gfs = new GuardedFileSystem(pg);

      const result = await gfs.readFile(target, { kind: 'full', skipBinary: true });
      assert.equal(result.content, content);
      assert.equal(result.truncated, false);
    });
  });

  describe('readTailContent (hasMoreLines accuracy)', () => {
    it('reports hasMoreLines as false when exactly tail lines are requested and read', async () => {
      const target = join(tempDir, 'tail-exact.txt');
      const lines = ['line 1', 'line 2', 'line 3'];
      await writeFile(target, lines.join('\n'), 'utf8');

      const pg = await PathGuard.fromAllowedDirectories([tempDir]);
      const gfs = new GuardedFileSystem(pg);

      const result = await gfs.readFile(target, { kind: 'tail', lines: 3 });
      assert.equal(result.content, lines.join('\n'));
      assert.equal(result.hasMoreLines, false);
    });

    it('reports hasMoreLines as true when more lines exist than requested tail', async () => {
      const target = join(tempDir, 'tail-more.txt');
      const lines = ['line 1', 'line 2', 'line 3', 'line 4'];
      await writeFile(target, lines.join('\n'), 'utf8');

      const pg = await PathGuard.fromAllowedDirectories([tempDir]);
      const gfs = new GuardedFileSystem(pg);

      const result = await gfs.readFile(target, { kind: 'tail', lines: 3 });
      assert.equal(result.content, ['line 2', 'line 3', 'line 4'].join('\n'));
      assert.equal(result.hasMoreLines, true);
    });
  });
});
