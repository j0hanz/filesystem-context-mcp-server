import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

describe('Directory normalization unification (TASK-008)', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizeAndValidateDirs normalizes a valid directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-dir-unify-'));
    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    const result = await normalizeAndValidateDirs([tempDir]);
    assert.ok(result.length === 1, 'Should return one directory');
    const dirName = tempDir.replace(/\\/g, '/').split('/').at(-1) ?? '';
    assert.ok(result[0]?.includes(dirName), 'Should include directory name');
  });

  it('normalizeAndValidateDirs deduplicates identical paths', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-dir-unify-'));
    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    const result = await normalizeAndValidateDirs([tempDir, tempDir]);
    assert.equal(result.length, 1, 'Duplicate directory should be deduplicated');
  });

  it('normalizeAndValidateDirs throws for a non-existent path', async () => {
    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    await assert.rejects(
      () => normalizeAndValidateDirs(['/this/path/does/not/exist/xyz123']),
      'Should throw for non-existent path',
    );
  });

  it('normalizeAndValidateDirs throws for a file path (not a directory)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-dir-unify-'));
    const { writeFile } = await import('node:fs/promises');
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'hello');

    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    await assert.rejects(
      () => normalizeAndValidateDirs([filePath]),
      'Should throw for a file path',
    );
  });

  it('normalizeAndValidateDirs with allowMissing=true tolerates non-existent path', async () => {
    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    const missingPath = '/this/path/does/not/exist/xyz123_missing';
    const result = await normalizeAndValidateDirs([missingPath], true);
    assert.ok(result.length === 1);
  });

  it('normalizeAndValidateDirs with allowMissing=true still throws for a file path', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-dir-unify-'));
    const { writeFile } = await import('node:fs/promises');
    const filePath = join(tempDir, 'test.txt');
    await writeFile(filePath, 'hello');

    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    await assert.rejects(
      () => normalizeAndValidateDirs([filePath], true),
      'Should throw for a file path even if allowMissing is true',
    );
  });

  it('normalizeAndValidateDirs deduplicates case-insensitively on Windows', async () => {
    if (process.platform !== 'win32') return;
    tempDir = await mkdtemp(join(tmpdir(), 'cli-dir-unify-'));
    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    const result = await normalizeAndValidateDirs([tempDir, tempDir.toUpperCase()]);
    assert.equal(result.length, 1, 'Should dedup case-insensitively on Windows');
  });

  it('FS_ALLOWED_DIRS and CLI positionals produce identical normalization via shared function', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cli-dir-unify-'));
    const sub1 = join(tempDir, 'sub1');
    const sub2 = join(tempDir, 'sub2');
    await mkdir(sub1);
    await mkdir(sub2);

    const { normalizeAndValidateDirs } = await import('../../src/cli.js');
    const { PathGuard } = await import('../../src/core/path.js');

    // CLI path: use the shared function directly
    const fromCli = await normalizeAndValidateDirs([sub1, sub2]);

    // FS_ALLOWED_DIRS path: PathGuard.recomputeAllowedDirectories reads the env var
    const origEnv = process.env['FS_ALLOWED_DIRS'];
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env['FS_ALLOWED_DIRS'] = [sub1, sub2].join(sep);
    try {
      const guard = new PathGuard();
      await guard.recomputeAllowedDirectories();
      const fromEnv = guard.getAllowedDirectories();

      // Both should contain the same paths (order may differ)
      for (const p of fromCli) {
        assert.ok(
          fromEnv.some((e) => e.toLowerCase() === p.toLowerCase()),
          `CLI path '${p}' must appear in env-derived allowed dirs`,
        );
      }
    } finally {
      if (origEnv === undefined) {
        delete process.env['FS_ALLOWED_DIRS'];
      } else {
        process.env['FS_ALLOWED_DIRS'] = origEnv;
      }
    }
  });
});
