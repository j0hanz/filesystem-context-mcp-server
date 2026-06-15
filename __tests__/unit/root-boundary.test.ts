import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { PathGuard } from '../../src/core/path.js';

describe('ROOT_BOUNDARY filtering', () => {
  const ORIG_BOUNDARY = process.env['ROOT_BOUNDARY'];
  const ORIG_DIRS = process.env['FS_ALLOWED_DIRS'];

  afterEach(() => {
    if (ORIG_BOUNDARY === undefined) {
      delete process.env['ROOT_BOUNDARY'];
    } else {
      process.env['ROOT_BOUNDARY'] = ORIG_BOUNDARY;
    }
    if (ORIG_DIRS === undefined) {
      delete process.env['FS_ALLOWED_DIRS'];
    } else {
      process.env['FS_ALLOWED_DIRS'] = ORIG_DIRS;
    }
  });

  it('allows client roots inside the boundary but filters roots outside', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'root-boundary-'));
    const boundaryDir = path.join(tempDir, 'boundary');
    const insideDir = path.join(boundaryDir, 'project-a');
    const outsideDir = path.join(tempDir, 'outside-project');

    const { mkdir } = await import('node:fs/promises');
    await mkdir(boundaryDir);
    await mkdir(insideDir);
    await mkdir(outsideDir);

    process.env['ROOT_BOUNDARY'] = boundaryDir;
    // Clear FS_ALLOWED_DIRS so baseline has no folders
    delete process.env['FS_ALLOWED_DIRS'];

    const guard = new PathGuard({ allowCwd: false });
    await guard.setRoots([insideDir, outsideDir]);

    const allowed = guard.getAllowedDirectories();
    // insideDir should be allowed because it falls under boundaryDir.
    // outsideDir should be filtered because it does not fall under boundaryDir.
    // boundaryDir itself should not be allowed.
    assert.ok(allowed.some((p) => p.toLowerCase() === insideDir.toLowerCase() || p === insideDir));
    assert.ok(
      !allowed.some((p) => p.toLowerCase() === outsideDir.toLowerCase() || p === outsideDir),
    );
    assert.ok(
      !allowed.some((p) => p.toLowerCase() === boundaryDir.toLowerCase() || p === boundaryDir),
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  it('empty-state warning names boundary when set with no roots', async () => {
    const { McpRootsSynchronizer } = await import('../../src/core/registrar.js');

    const logged: { level: string; data: string }[] = [];
    const mockServer = {
      server: {
        getClientCapabilities: () => ({ logging: {} }),
      },
      sendLoggingMessage: async (params: { level: string; data: string }) => {
        logged.push(params);
      },
    } as unknown as McpServer;

    const guard = new PathGuard({ allowCwd: false }, { minimumLevel: 'debug' });

    // Set ROOT_BOUNDARY to a valid temp dir
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const tempDir = await mkdtemp(path.join(tmpdir(), 'root-boundary-warn-'));

    process.env['ROOT_BOUNDARY'] = tempDir;
    await guard.recomputeAllowedDirectories();

    const synchronizer = new McpRootsSynchronizer(guard, { minimumLevel: 'debug' });
    synchronizer.logMissingDirectoriesIfNeeded(mockServer);

    assert.equal(logged.length, 1);
    const msg = logged[0].data;
    assert.strictEqual(logged[0].level, 'warning');
    assert.match(msg, /boundary/i);
    assert.match(msg, /roots/i);

    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves symlinked roots inside/outside boundary correctly', async () => {
    const { mkdtemp, rm, symlink } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'root-boundary-symlink-'));
    const boundaryDir = path.join(tempDir, 'boundary');
    const outsideDir = path.join(tempDir, 'outside');

    const realInsideDir = path.join(boundaryDir, 'real-inside');
    const realOutsideDir = path.join(outsideDir, 'real-outside');

    const symlinkInside = path.join(tempDir, 'symlink-inside');
    const symlinkOutside = path.join(tempDir, 'symlink-outside');

    const { mkdir } = await import('node:fs/promises');
    await mkdir(boundaryDir);
    await mkdir(outsideDir);
    await mkdir(realInsideDir);
    await mkdir(realOutsideDir);

    await symlink(realInsideDir, symlinkInside, 'junction');
    await symlink(realOutsideDir, symlinkOutside, 'junction');

    process.env['ROOT_BOUNDARY'] = boundaryDir;
    delete process.env['FS_ALLOWED_DIRS'];

    const guard = new PathGuard({ allowCwd: false });
    await guard.setRoots([symlinkInside, symlinkOutside]);

    const allowed = guard.getAllowedDirectories();
    // symlinkInside resolves to realInsideDir which is within boundaryDir.
    // symlinkOutside resolves to realOutsideDir which is outside boundaryDir.
    assert.ok(
      allowed.some((p) => p.toLowerCase() === realInsideDir.toLowerCase() || p === realInsideDir),
    );
    assert.ok(
      !allowed.some(
        (p) => p.toLowerCase() === realOutsideDir.toLowerCase() || p === realOutsideDir,
      ),
    );

    await rm(tempDir, { recursive: true, force: true });
  });
});
