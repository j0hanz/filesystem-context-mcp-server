import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { parseEnvDirList } from '../../src/core/primitives.js';

describe('parseEnvDirList', () => {
  it('correctly splits paths using the platform separator and drops empty/trimmed tokens', () => {
    const backup = process.env['TEST_ENV_DIRS'];
    try {
      if (process.platform === 'win32') {
        process.env['TEST_ENV_DIRS'] = 'C:\\foo;  ; C:\\bar\\;;C:\\baz ';
        const result = parseEnvDirList('TEST_ENV_DIRS');
        assert.deepEqual(result, ['C:\\foo', 'C:\\bar\\', 'C:\\baz']);
      } else {
        process.env['TEST_ENV_DIRS'] = '/foo:  : /bar/::/baz ';
        const result = parseEnvDirList('TEST_ENV_DIRS');
        assert.deepEqual(result, ['/foo', '/bar/', '/baz']);
      }
    } finally {
      if (backup === undefined) {
        delete process.env['TEST_ENV_DIRS'];
      } else {
        process.env['TEST_ENV_DIRS'] = backup;
      }
    }
  });

  it('returns an empty array when env var is undefined or empty', () => {
    const backup = process.env['TEST_ENV_DIRS'];
    try {
      delete process.env['TEST_ENV_DIRS'];
      assert.deepEqual(parseEnvDirList('TEST_ENV_DIRS'), []);

      process.env['TEST_ENV_DIRS'] = '';
      assert.deepEqual(parseEnvDirList('TEST_ENV_DIRS'), []);

      process.env['TEST_ENV_DIRS'] = '   ';
      assert.deepEqual(parseEnvDirList('TEST_ENV_DIRS'), []);
    } finally {
      if (backup === undefined) {
        delete process.env['TEST_ENV_DIRS'];
      } else {
        process.env['TEST_ENV_DIRS'] = backup;
      }
    }
  });
});

describe('PathGuard.recomputeAllowedDirectories with FS_ALLOWED_DIRS', () => {
  const ORIG = process.env['FS_ALLOWED_DIRS'];

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env['FS_ALLOWED_DIRS'];
    } else {
      process.env['FS_ALLOWED_DIRS'] = ORIG;
    }
  });

  it('wires FS_ALLOWED_DIRS into baseline, validates directories, expands symlinks, and warns on invalid paths', async () => {
    const { mkdtemp, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { PathGuard } = await import('../../src/core/path.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'env-allowed-dirs-'));
    const subDir1 = path.join(tempDir, 'sub1');
    const subDir2 = path.join(tempDir, 'sub2');
    const symlinkDir = path.join(tempDir, 'symlink-sub1');
    const nonExistentDir = path.join(tempDir, 'missing');

    const { mkdir } = await import('node:fs/promises');
    await mkdir(subDir1);
    await mkdir(subDir2);
    await symlink(subDir1, symlinkDir, 'junction'); // 'junction' / 'dir' on Windows

    // Set FS_ALLOWED_DIRS
    process.env['FS_ALLOWED_DIRS'] =
      `${subDir2}${process.platform === 'win32' ? ';' : ':'}${symlinkDir}${process.platform === 'win32' ? ';' : ':'}${nonExistentDir}`;

    const warnings: string[] = [];
    const mockSender = {
      send: async (level: string, data: string) => {
        if (level === 'warning') {
          warnings.push(data);
        }
      },
    };

    const guard = new PathGuard();
    await guard.recomputeAllowedDirectories(mockSender);

    const allowed = guard.getAllowedDirectories();
    // subDir2 and symlinkDir (resolved to subDir1) should be present.
    // nonExistentDir should be dropped, and warning logged.
    assert.ok(allowed.some((p) => p.toLowerCase() === subDir2.toLowerCase() || p === subDir2));
    assert.ok(allowed.some((p) => p.toLowerCase() === subDir1.toLowerCase() || p === subDir1));
    assert.ok(
      !allowed.some(
        (p) => p.toLowerCase() === nonExistentDir.toLowerCase() || p === nonExistentDir,
      ),
    );

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('missing'));

    await rm(tempDir, { recursive: true, force: true });
  });

  it('allows access to files within the env allowed directory and denies access outside', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { PathGuard } = await import('../../src/core/path.js');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'env-allowed-dirs-access-'));
    const allowedSub = path.join(tempDir, 'allowed');
    const deniedSub = path.join(tempDir, 'denied');

    const { mkdir } = await import('node:fs/promises');
    await mkdir(allowedSub);
    await mkdir(deniedSub);

    const allowedFile = path.join(allowedSub, 'ok.txt');
    const deniedFile = path.join(deniedSub, 'no.txt');

    await writeFile(allowedFile, 'ok');
    await writeFile(deniedFile, 'no');

    process.env['FS_ALLOWED_DIRS'] = allowedSub;

    const guard = new PathGuard();
    await guard.recomputeAllowedDirectories();

    // Verify allowed file resolves successfully
    const resolved = await guard.validateExistingPath(allowedFile);
    assert.ok(resolved.toLowerCase().includes('ok.txt'));

    // Verify denied file throws ACCESS_DENIED
    await assert.rejects(
      () => guard.validateExistingPath(deniedFile),
      /outside allowed directories/i,
    );

    await rm(tempDir, { recursive: true, force: true });
  });
});
