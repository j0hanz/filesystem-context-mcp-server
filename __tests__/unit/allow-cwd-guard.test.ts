import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { describe, it } from 'node:test';

import { isUnsafeCwdPath, normalizePath, PathGuard } from '../../src/core/path.js';

describe('--allow-cwd safety guard', () => {
  it('isUnsafeCwdPath identifies unsafe dirs correctly', () => {
    // (a) filesystem root rejected
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    assert.strictEqual(isUnsafeCwdPath(normalizePath(root)), true);

    // (b) homedir rejected
    assert.strictEqual(isUnsafeCwdPath(normalizePath(homedir())), true);

    // (c) C:\Windows rejected (only on Windows)
    if (process.platform === 'win32') {
      assert.strictEqual(isUnsafeCwdPath(normalizePath('C:\\Windows')), true);
      assert.strictEqual(isUnsafeCwdPath(normalizePath('C:\\Program Files')), true);
    }

    // (d) /usr rejected
    assert.strictEqual(isUnsafeCwdPath(normalizePath('/usr')), true);
    assert.strictEqual(isUnsafeCwdPath(normalizePath('/etc')), true);

    // (e) normal project directory accepted
    const safe =
      process.platform === 'win32' ? 'C:\\Users\\user\\projects\\app' : '/home/user/projects/app';
    assert.strictEqual(isUnsafeCwdPath(normalizePath(safe)), false);
  });

  it('skips adding unsafe cwd, emits warning, and continues normally', async () => {
    const originalCwd = process.cwd.bind(process);

    const home = homedir();
    // Stub process.cwd to return homedir (which is unsafe)
    process.cwd = () => home;

    const warnings: string[] = [];
    const mockSender = {
      send: async (level: string, data: string) => {
        if (level === 'warning') {
          warnings.push(data);
        }
      },
    };

    try {
      const guard = new PathGuard({ allowCwd: true });
      // (g) server continues normally (no throw)
      await guard.recomputeAllowedDirectories(mockSender);

      // Verify homedir is NOT added
      const allowed = guard.getAllowedDirectories();
      assert.ok(!allowed.includes(home));

      // (f) warning is emitted
      assert.ok(warnings.length > 0);
      assert.ok(warnings[0].includes('unsafe current working directory'));
    } finally {
      process.cwd = originalCwd;
    }
  });
});
