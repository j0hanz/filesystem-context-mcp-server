import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ErrorCode } from '../../src/core/errors.js';
import {
  type AllowedDirectoriesState,
  IS_WINDOWS,
  isSafeGlobSyntax,
  PathGuard,
} from '../../src/core/path.js';
import { SensitiveMatcher } from '../../src/core/sensitive.js';

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

// Characterize the operator-supplied denylist contract: custom DENYLIST
// patterns match, ALLOW_SENSITIVE suppresses built-ins but NOT operator
// entries, and separators split correctly. Safety net for the Windows
// trailing-dot normalization change (Plan 002).

test('SensitiveMatcher honors custom DENYLIST patterns', () => {
  const matcher = new SensitiveMatcher(['secrets/**', '*.pem']);
  // rooted glob variant is added by compilePatternGlobs
  assert.strictEqual(matcher.isSensitive('secrets/api.key'), true);
  assert.strictEqual(matcher.isSensitive('config/secrets/api.key'), true);
  assert.strictEqual(matcher.isSensitive('public.txt'), false);
  assert.strictEqual(matcher.isSensitive('server.pem'), true);
  assert.strictEqual(matcher.isSensitive('src/server.ts'), false);
});

test('ALLOW_SENSITIVE suppresses built-ins but not operator DENYLIST entries', () => {
  const savedAllow = process.env['ALLOW_SENSITIVE'];
  const savedDeny = process.env['DENYLIST'];
  process.env['ALLOW_SENSITIVE'] = '1';
  process.env['DENYLIST'] = 'secrets/**';
  try {
    const matcher = new SensitiveMatcher(); // calls buildSensitivePatterns()
    // built-in .env is suppressed by ALLOW_SENSITIVE
    assert.strictEqual(matcher.isSensitive('.env'), false);
    // operator DENYLIST entry still applies
    assert.strictEqual(matcher.isSensitive('secrets/api.key'), true);
    assert.strictEqual(matcher.isSensitive('public.txt'), false);
  } finally {
    if (savedAllow === undefined) delete process.env['ALLOW_SENSITIVE'];
    else process.env['ALLOW_SENSITIVE'] = savedAllow;
    if (savedDeny === undefined) delete process.env['DENYLIST'];
    else process.env['DENYLIST'] = savedDeny;
  }
});

test('DENYLIST with comma and newline separators is split correctly', () => {
  const savedDeny = process.env['DENYLIST'];
  process.env['DENYLIST'] = '*.pem,secrets/**\n*.key';
  try {
    const matcher = new SensitiveMatcher();
    assert.strictEqual(matcher.isSensitive('a.pem'), true);
    assert.strictEqual(matcher.isSensitive('secrets/x'), true);
    assert.strictEqual(matcher.isSensitive('b.key'), true);
    assert.strictEqual(matcher.isSensitive('b.txt'), false);
  } finally {
    if (savedDeny === undefined) delete process.env['DENYLIST'];
    else process.env['DENYLIST'] = savedDeny;
  }
});

test('isSafeGlobSyntax returns false for traversal patterns', () => {
  assert.strictEqual(isSafeGlobSyntax('../**'), false);
  assert.strictEqual(isSafeGlobSyntax('/etc/passwd'), false);
  assert.strictEqual(isSafeGlobSyntax(''), false);
});

test('isSafeGlobSyntax returns true for safe patterns', () => {
  assert.strictEqual(isSafeGlobSyntax('*.ts'), true);
  assert.strictEqual(isSafeGlobSyntax('src/**/*.ts'), true);
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

// ─── Symlink-to-sensitive-file denylist bypass ────────────────────────────────
// A benign-named symlink inside an allowed root pointing at a sensitive file
// must be blocked: the denylist has to be enforced on the resolved real path,
// not only on the requested/normalized path.

test('validateExistingPath rejects a benign symlink whose target is sensitive', async () => {
  const secret = join(tmpDir, '.env');
  const link = join(tmpDir, 'notes.txt'); // benign name — not on the denylist
  await writeFile(secret, 'SECRET=1');

  let linked = true;
  try {
    await symlink(secret, link, 'file');
  } catch {
    linked = false; // symlink creation may require privileges on Windows
  }
  if (!linked) return;

  await assert.rejects(
    () => guard.validateExistingPath(link),
    (err: unknown) => hasErrorCode(err, ErrorCode.ACCESS_DENIED),
    'read through a symlink to a sensitive file must be denied',
  );
});

test('validatePathForWrite rejects a benign symlink whose target is sensitive', async () => {
  const secret = join(tmpDir, '.env.write');
  const link = join(tmpDir, 'write-notes.txt'); // benign name — not on the denylist
  await writeFile(secret, 'SECRET=1');

  let linked = true;
  try {
    await symlink(secret, link, 'file');
  } catch {
    linked = false;
  }
  if (!linked) return;

  await assert.rejects(
    () => guard.validatePathForWrite(link),
    (err: unknown) => hasErrorCode(err, ErrorCode.ACCESS_DENIED),
    'writing through a symlink to a sensitive file must be denied',
  );
});

// ─── REQ-001: Nonexistent file via out-of-sandbox symlink parent ──────────────

test('validateExistingPath throws ACCESS_DENIED for nonexistent file via out-of-sandbox symlink parent', async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'path-guard-outside-'));
  const linkPath = join(tmpDir, 'out-link-dir');

  let linked = true;
  try {
    await symlink(outsideDir, linkPath, 'dir');
  } catch {
    linked = false;
  }

  try {
    if (!linked) return;
    await assert.rejects(
      () => guard.validateExistingPath(join(linkPath, 'nonexistent.txt')),
      (err: unknown) => hasErrorCode(err, ErrorCode.ACCESS_DENIED),
      'nonexistent file under out-of-sandbox symlink parent must throw ACCESS_DENIED, not NOT_FOUND',
    );
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// ─── REQ-002: NTFS Alternate Data Stream bypass ───────────────────────────────

test('isSensitive blocks .env:secret ADS path on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('ADS stripping is Windows-only');
    return;
  }
  assert.strictEqual(guard.isSensitive('.env:secret'), true, '.env:secret must be blocked');
  assert.strictEqual(
    guard.isSensitive('.env.local:stream'),
    true,
    '.env.local:stream must be blocked',
  );
  assert.strictEqual(guard.isSensitive('key.pem:hidden'), true, 'key.pem:hidden must be blocked');
});

test('isSensitive blocks sensitive filename with ADS in a directory path on Windows', (t) => {
  if (process.platform !== 'win32') {
    t.skip('ADS stripping is Windows-only');
    return;
  }
  assert.strictEqual(
    guard.isSensitive('subdir\\.env:stream'),
    true,
    '.env:stream as final segment must be blocked',
  );
});

test('isSensitive does not break Windows drive-letter colon', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Drive-letter paths are Windows-only');
    return;
  }
  assert.strictEqual(
    guard.isSensitive('C:\\path\\normal.txt'),
    false,
    'C:\\ absolute path must not be broken',
  );
  assert.strictEqual(
    guard.isSensitive('D:\\logs\\app.log'),
    false,
    'D:\\ absolute path must not be broken',
  );
});

test('isSensitive strips Windows trailing dot/space (denylist bypass fix)', () => {
  const matcher = new SensitiveMatcher(['.env', '.npmrc']);
  if (IS_WINDOWS) {
    // Win32 strips trailing dot/space at the syscall boundary -> must match.
    assert.strictEqual(matcher.isSensitive('.env '), true);
    assert.strictEqual(matcher.isSensitive('.env.'), true);
    assert.strictEqual(matcher.isSensitive('.env...'), true);
    assert.strictEqual(matcher.isSensitive('.npmrc '), true);
  } else {
    // POSIX: trailing dot/space are real filename chars, distinct from .env.
    assert.strictEqual(matcher.isSensitive('.env '), false);
  }
  // Both platforms: the plain name still matches.
  assert.strictEqual(matcher.isSensitive('.env'), true);
});

// ─── isEntryAccessible (R2 — moved in from glob.ts) ────────────────────────────

test('isEntryAccessible returns false for a sensitive file', async () => {
  const secret = join(tmpDir, '.env.entry-access');
  await writeFile(secret, 'SECRET=1');
  assert.strictEqual(await guard.isEntryAccessible(secret, 'file', [tmpDir]), false);
});

test('isEntryAccessible returns true for a non-sensitive file within bounds', async () => {
  const file = join(tmpDir, 'entry-access.txt');
  await writeFile(file, 'hello');
  assert.strictEqual(await guard.isEntryAccessible(file, 'file', [tmpDir]), true);
});

test('isEntryAccessible returns false for a symlink escaping bounds', async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'path-guard-entry-outside-'));
  const outsideFile = join(outsideDir, 'secret.txt');
  await writeFile(outsideFile, 'secret');
  const linkPath = join(tmpDir, 'entry-access-link.txt');

  let linked = true;
  try {
    await symlink(outsideFile, linkPath, 'file');
  } catch {
    linked = false; // symlink creation may require privileges on Windows
  }

  try {
    if (!linked) return;
    assert.strictEqual(await guard.isEntryAccessible(linkPath, 'symlink', [tmpDir]), false);
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('isEntryAccessible returns false for an entry outside bounds', async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'path-guard-entry-bounds-'));
  const outsideFile = join(outsideDir, 'file.txt');
  await writeFile(outsideFile, 'hello');

  try {
    assert.strictEqual(await guard.isEntryAccessible(outsideFile, 'file', [tmpDir]), false);
  } finally {
    await rm(outsideDir, { recursive: true, force: true });
  }
});

// A symlinked DIRECTORY inside an allowed root pointing outside the sandbox:
// fs.glob follows it and yields the external file as a non-symlink dirent, so
// the lexical-only check used to pass it. realpath resolution must filter it.
test('isEntryAccessible blocks entries under a symlinked dir pointing outside the root', async () => {
  if (IS_WINDOWS) {
    // symlink creation may require elevated privileges / developer mode on Windows
    let probe = true;
    try {
      await symlink(join(tmpDir, 'probe-link-target'), join(tmpDir, 'probe-link'), 'dir');
    } catch {
      probe = false;
    } finally {
      await rm(join(tmpDir, 'probe-link'), { force: true });
    }
    if (!probe) return; // cannot create symlinks here; POSIX CI covers the regression
  }

  const outside = await mkdtemp(join(tmpdir(), 'path-guard-outside-'));
  try {
    await writeFile(join(outside, 'leaked.txt'), 'secret');
    const linkPath = join(tmpDir, 'escape-link');
    await symlink(outside, linkPath, 'dir');
    // The external file reached through the symlinked dir must be filtered.
    const accessible = await guard.isEntryAccessible(join(linkPath, 'leaked.txt'), 'file', [
      tmpDir,
    ]);
    assert.strictEqual(accessible, false);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
