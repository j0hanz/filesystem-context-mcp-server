import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';

import { findProjectRoot, normalizePath, PathGuard } from '../../src/core/path.js';

describe('findProjectRoot ancestor walk', () => {
  it('finds project root by walking up to markers and respects boundaries', async () => {
    const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'cwd-walk-'));
    const parentDir = path.join(tempDir, 'parent');
    const projectDir = path.join(parentDir, 'project');
    const srcDir = path.join(projectDir, 'src');
    const nestedDir = path.join(srcDir, 'components');

    await mkdir(parentDir);
    await mkdir(projectDir);
    await mkdir(srcDir);
    await mkdir(nestedDir);

    // (b) walk finds package.json ancestor
    await writeFile(path.join(projectDir, 'package.json'), '{}');
    let root = await findProjectRoot(nestedDir, [tempDir]);
    assert.strictEqual(root.toLowerCase(), projectDir.toLowerCase());

    // Clean package.json and create .git directory
    await rm(path.join(projectDir, 'package.json'));
    await mkdir(path.join(projectDir, '.git'));

    // (a) walk finds .git ancestor
    root = await findProjectRoot(nestedDir, [tempDir]);
    assert.strictEqual(root.toLowerCase(), projectDir.toLowerCase());

    // (c) walk falls back to startDir when no marker found
    await rm(path.join(projectDir, '.git'), { recursive: true, force: true });
    root = await findProjectRoot(nestedDir, [tempDir]);
    assert.strictEqual(root.toLowerCase(), nestedDir.toLowerCase());

    // (e) walk stops at ROOT_BOUNDARY ceiling
    // Create marker at tempDir level (outside parentDir boundary)
    await writeFile(path.join(tempDir, 'package.json'), '{}');
    root = await findProjectRoot(nestedDir, [parentDir]); // ceiling is parentDir
    // Since ceiling is parentDir, the walk cannot cross parentDir to reach tempDir.
    // So it should fall back to nestedDir (since no marker found inside parentDir ceiling).
    assert.strictEqual(root.toLowerCase(), nestedDir.toLowerCase());

    await rm(tempDir, { recursive: true, force: true });
  });

  it('respects homedir boundary', async () => {
    const home = homedir();
    // (d) Since home is the ceiling, the walk must not escape home
    const root = await findProjectRoot(home, [home]);
    assert.strictEqual(root.toLowerCase(), normalizePath(home).toLowerCase());
  });

  it('integration: recomputeAllowedDirectories uses ALLOW_CWD_WALK', async () => {
    const { mkdtemp, rm, writeFile, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');

    const tempDir = await mkdtemp(path.join(tmpdir(), 'cwd-walk-int-'));
    const projectDir = path.join(tempDir, 'myproject');
    const srcDir = path.join(projectDir, 'src');

    await mkdir(projectDir);
    await mkdir(srcDir);
    await writeFile(path.join(projectDir, 'package.json'), '{}');

    const originalCwd = process.cwd.bind(process);
    process.cwd = () => srcDir;

    const ORIG_WALK = process.env['ALLOW_CWD_WALK'];
    process.env['ALLOW_CWD_WALK'] = '1';

    try {
      const guard = new PathGuard({ allowCwd: true });
      await guard.recomputeAllowedDirectories();

      const allowed = guard.getAllowedDirectories();
      // Should have projectDir (parent of srcDir) in allowed directories
      assert.ok(
        allowed.some((p) => p.toLowerCase() === projectDir.toLowerCase() || p === projectDir),
      );
      assert.ok(!allowed.some((p) => p.toLowerCase() === srcDir.toLowerCase() || p === srcDir));
    } finally {
      process.cwd = originalCwd;
      if (ORIG_WALK === undefined) {
        delete process.env['ALLOW_CWD_WALK'];
      } else {
        process.env['ALLOW_CWD_WALK'] = ORIG_WALK;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
