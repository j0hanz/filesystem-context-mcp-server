import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode } from '../../src/core/errors.js';
import { type AllowedDirectoriesState, PathGuard } from '../../src/core/path.js';

function hasErrorCode(err: unknown, code: ErrorCode): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

let tmpDir: string;
let guard: PathGuard;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'path-guard-test-'));
  const state: AllowedDirectoriesState = {
    primary: [tmpDir],
    expanded: [tmpDir],
  };
  guard = new PathGuard();
  guard.initialize(state);
});

after(async () => {
  if (!tmpDir) return;
  await rm(tmpDir, { recursive: true, force: true });
});

test('validateExistingPath resolves a file within allowed dir', async () => {
  await writeFile(join(tmpDir, 'test.txt'), 'hello');
  const resolved = await guard.validateExistingPath(join(tmpDir, 'test.txt'));
  assert.ok(resolved.includes('test.txt'));
});

test('validateExistingPath rejects path outside allowed dirs', async () => {
  await assert.rejects(
    () => guard.validateExistingPath('/tmp/outside-xyz-impossible/file.txt'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

test('isSensitive returns true for .env files', () => {
  assert.strictEqual(guard.isSensitive('.env'), true);
  assert.strictEqual(guard.isSensitive('.env.local'), true);
});

test('isSensitive returns false for normal files', () => {
  assert.strictEqual(guard.isSensitive('src/index.ts'), false);
  assert.strictEqual(guard.isSensitive('README.md'), false);
});

test('isSafeGlob returns false for traversal patterns', () => {
  assert.strictEqual(guard.isSafeGlob('../**'), false);
  assert.strictEqual(guard.isSafeGlob('/etc/passwd'), false);
  assert.strictEqual(guard.isSafeGlob(''), false);
});

test('isSafeGlob returns true for safe patterns', () => {
  assert.strictEqual(guard.isSafeGlob('*.ts'), true);
  assert.strictEqual(guard.isSafeGlob('src/**/*.ts'), true);
});

test('isSensitive works before initialize()', () => {
  const uninit = new PathGuard();
  assert.strictEqual(uninit.isSensitive('.env'), true);
});

test('validateExistingPath throws before initialize()', async () => {
  const uninit = new PathGuard();
  await assert.rejects(
    () => uninit.validateExistingPath(join(tmpDir, 'test.txt')),
    /not initialized|allowed/i,
  );
});

test('getAllowedDirectories returns the initialized dirs', () => {
  const dirs = guard.getAllowedDirectories();
  assert.ok(dirs.some((d) => d === tmpDir || d.toLowerCase() === tmpDir.toLowerCase()));
});

test('validateExistingDirectory rejects a file path', async () => {
  await writeFile(join(tmpDir, 'notadir.txt'), 'x');
  await assert.rejects(
    () => guard.validateExistingDirectory(join(tmpDir, 'notadir.txt')),
    /directory/i,
  );
});

test('validatePathForWrite returns normalized path for new file', async () => {
  const newPath = join(tmpDir, 'new-file.txt');
  const result = await guard.validatePathForWrite(newPath);
  assert.ok(typeof result === 'string' && result.length > 0);
});

test('isInitialized returns false before initialize() is called', () => {
  const freshGuard = new PathGuard();
  assert.strictEqual(freshGuard.isInitialized(), false);
});

test('isInitialized returns true after initialize() is called', () => {
  const freshGuard = new PathGuard();
  const state: AllowedDirectoriesState = {
    primary: [tmpDir],
    expanded: [tmpDir],
  };
  freshGuard.initialize(state);
  assert.strictEqual(freshGuard.isInitialized(), true);
});

// ─── Reserved device names / drive-relative paths (runtime validation) ─────────

for (const device of ['CON', 'NUL', 'COM1', 'con.txt', 'nul ']) {
  test(`validateAccess rejects reserved device name "${device}" on every path entry point`, async () => {
    const candidate = join(tmpDir, device);
    await assert.rejects(
      () => guard.validatePathForWrite(candidate),
      (err: unknown) => hasErrorCode(err, ErrorCode.ACCESS_DENIED),
      'write path must reject reserved device names',
    );
    await assert.rejects(
      () => guard.validateExistingPath(candidate),
      (err: unknown) => hasErrorCode(err, ErrorCode.ACCESS_DENIED),
      'read path must reject reserved device names',
    );
    await assert.rejects(
      () => guard.validatePathForDelete(candidate),
      (err: unknown) => hasErrorCode(err, ErrorCode.ACCESS_DENIED),
      'delete path must reject reserved device names',
    );
  });
}

test('validateAccess allows non-reserved names that merely contain a device prefix', async () => {
  // "console.txt"/"computer" are NOT reserved (base name is not exactly CON/COM1).
  const ok = await guard.validatePathForWrite(join(tmpDir, 'console.txt'));
  assert.ok(ok.includes('console.txt'));
});

test('validateAccess rejects Windows drive-relative paths (Windows only)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('drive-relative paths are a Windows-only concept');
    return;
  }
  await assert.rejects(
    () => guard.validatePathForWrite('C:relative-no-slash'),
    (err: unknown) => hasErrorCode(err, ErrorCode.INVALID_INPUT),
  );
});

// ─── Write-path symlink canonicalization (TOCTOU mitigation) ──────────────────

test('validatePathForWrite returns the resolved target through a symlinked parent', async () => {
  const realDir = join(tmpDir, 'real-parent');
  const linkDir = join(tmpDir, 'link-parent');
  await mkdir(realDir, { recursive: true });

  let linked = true;
  try {
    await symlink(realDir, linkDir, 'dir');
  } catch {
    linked = false; // symlink creation may require privileges on Windows
  }
  if (!linked) return;

  // Writing "through" the symlinked parent must resolve to the real directory,
  // so downstream syscalls act on the canonical location, not the swappable link.
  const resolved = await guard.validatePathForWrite(join(linkDir, 'child.txt'));
  assert.ok(
    resolved.toLowerCase().includes('real-parent'),
    `expected resolved target under real-parent, got ${resolved}`,
  );
  assert.ok(
    !resolved.toLowerCase().includes('link-parent'),
    `resolved target must not retain the symlink component, got ${resolved}`,
  );
});
