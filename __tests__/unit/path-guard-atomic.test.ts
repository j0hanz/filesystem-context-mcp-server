import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PathGuard } from '../../src/core/path.js';

// A path holding a NUL byte: fs.realpath rejects it with ERR_INVALID_ARG_VALUE
// (not ENOENT), so resolveRealPath rethrows instead of suppressing it. That is
// the cross-platform way to make resolveAllowedDirectoriesState reject.
const BAD_REALPATH_DIR = 'bad\0dir';

function assertRealpathError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_INVALID_ARG_VALUE';
}

describe('PathGuard atomic recompute', () => {
  it('keeps the previous allowed dirs and boundaries when recompute rejects', async () => {
    const goodDir = await mkdtemp(join(tmpdir(), 'path-guard-atomic-'));
    try {
      const pathGuard = new PathGuard({ cliAllowedDirs: [goodDir] });
      await pathGuard.setRoots([]);

      const allowedBefore = pathGuard.getAllowedDirectories();
      const boundariesBefore = pathGuard.getRootBoundaries();
      assert.ok(allowedBefore.length > 0, 'expected the good dir to be allowed');

      // Poison the cli-allowed dirs so the next recompute rejects inside
      // resolveAllowedDirectoriesState (realpath of the NUL path throws).
      (pathGuard.options as { cliAllowedDirs: string[] }).cliAllowedDirs.push(BAD_REALPATH_DIR);

      await assert.rejects(
        () => pathGuard.recomputeAllowedDirectories(),
        assertRealpathError,
        'recompute must reject with the non-ENOENT realpath error',
      );

      assert.deepEqual(pathGuard.getAllowedDirectories(), allowedBefore);
      assert.deepEqual(pathGuard.getRootBoundaries(), boundariesBefore);
    } finally {
      await rm(goodDir, { recursive: true, force: true });
    }
  });

  it('keeps the previous view when setRoots rejects', async () => {
    const goodDir = await mkdtemp(join(tmpdir(), 'path-guard-atomic-roots-'));
    try {
      const pathGuard = new PathGuard({ cliAllowedDirs: [goodDir] });
      await pathGuard.setRoots(['/some/initial/root']);

      const allowedBefore = pathGuard.getAllowedDirectories();
      const boundariesBefore = pathGuard.getRootBoundaries();
      assert.ok(allowedBefore.length > 0);

      (pathGuard.options as { cliAllowedDirs: string[] }).cliAllowedDirs.push(BAD_REALPATH_DIR);

      await assert.rejects(() => pathGuard.setRoots(['/some/new/root']), assertRealpathError);

      assert.deepEqual(pathGuard.getAllowedDirectories(), allowedBefore);
      assert.deepEqual(pathGuard.getRootBoundaries(), boundariesBefore);
    } finally {
      await rm(goodDir, { recursive: true, force: true });
    }
  });
});
