import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { type AllowedDirectoriesState, PathGuard } from '../../src/core/path.js';
import { SENSITIVE_FILE_DENYLIST } from '../../src/core/util.js';

let tmpDir: string;
let guard: PathGuard;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'path-guard-test-'));
  const state: AllowedDirectoriesState = {
    primary: [tmpDir],
    expanded: [tmpDir],
  };
  guard = new PathGuard(SENSITIVE_FILE_DENYLIST);
  guard.initialize(state);
});

after(async () => {
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
  const uninit = new PathGuard(SENSITIVE_FILE_DENYLIST);
  assert.strictEqual(uninit.isSensitive('.env'), true);
});

test('validateExistingPath throws before initialize()', async () => {
  const uninit = new PathGuard(SENSITIVE_FILE_DENYLIST);
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
