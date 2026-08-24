import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode, isFsError, isNodeError } from '../src/core/errors.js';
import { isSamePath, PathGuard } from '../src/core/path.js';
import { cleanupTestRoot, createTestRoot, writeTestFile } from './helpers.js';

// Grant round-trip characterization: precheckAccess → applyGrant → the
// guard's allowed-directory view. These pin the working behavior (and, in
// TC-PG-005, the known broken case plan 002 fixes) so future regressions fail
// loudly. Real tmpdir paths; no stubbed realpath — the TOCTOU window is real.

const mkDir = async (created: string[], prefix: string): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  created.push(d);
  return d;
};

const containsPath = (dirs: readonly string[], target: string): boolean =>
  dirs.some((d) => isSamePath(d, target));

describe('PathGuard grant round-trip', () => {
  let root: string;
  let createdDirs: string[];
  let savedBoundary: string | undefined;

  beforeEach(async () => {
    root = await createTestRoot();
    createdDirs = [];
    savedBoundary = process.env['ROOT_BOUNDARY'];
  });

  afterEach(async () => {
    if (savedBoundary === undefined) delete process.env['ROOT_BOUNDARY'];
    else process.env['ROOT_BOUNDARY'] = savedBoundary;
    for (const d of createdDirs) await cleanupTestRoot(d);
    if (root) await cleanupTestRoot(root);
  });

  it('TC-PG-001: precheckAccess returns [] for a path already inside an allowed root', async () => {
    const guard = await PathGuard.fromAllowedDirectories([root]);
    const inside = join(root, 'file.txt');

    const grants = await guard.precheckAccess([inside]);

    assert.deepStrictEqual(grants, []);
  });

  it('TC-PG-002: within ROOT_BOUNDARY, precheckAccess offers the ancestor and applyGrant extends access', async () => {
    const boundary = tmpdir();
    const outOfRoot = await mkDir(createdDirs, 'fsmcp-pg002-');
    process.env['ROOT_BOUNDARY'] = boundary;

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const grants = await guard.precheckAccess([outOfRoot]);
    assert.strictEqual(grants.length, 1, 'precheck should offer one grant dir');
    const grantDir = grants[0]!;
    assert.ok(containsPath([grantDir], outOfRoot), 'offered dir should be the out-of-root target');

    const accepted = await guard.applyGrant(grantDir);
    assert.strictEqual(accepted, true, 'applyGrant should succeed within boundary');

    // After the grant the out-of-root path must resolve without ACCESS_DENIED.
    await assert.doesNotReject(
      guard.validateExistingPath(outOfRoot),
      'granted path should be accessible after applyGrant',
    );
  });

  it('TC-PG-003: outside ROOT_BOUNDARY, precheckAccess offers nothing and applyGrant denies', async () => {
    // Boundary is the test root itself: any sibling tmpdir is outside it.
    process.env['ROOT_BOUNDARY'] = root;
    const outOfRoot = await mkDir(createdDirs, 'fsmcp-pg003-');

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();
    const before = guard.getAllowedDirectories();

    const grants = await guard.precheckAccess([outOfRoot]);
    assert.deepStrictEqual(grants, [], 'precheck should not offer a dir outside the boundary');

    const accepted = await guard.applyGrant(outOfRoot);
    assert.strictEqual(accepted, false, 'applyGrant should refuse outside the boundary');

    const after = guard.getAllowedDirectories();
    assert.strictEqual(
      after.length,
      before.length,
      'allowed dirs must not grow when a grant is refused',
    );
    assert.ok(!containsPath(after, outOfRoot), 'refused grant must not appear in allowed dirs');
  });

  it('TC-PG-004: precheckAccess offers [] when the only existing ancestor is a bare filesystem root', async () => {
    const guard = await PathGuard.fromAllowedDirectories([root]);
    // A path whose every intermediate segment is missing: walking up reaches
    // the filesystem root, which precheckAccess must never offer as a grant.
    const unique = `fsmcp_pg004_${Date.now()}`;
    const deepMissing = join(parse(root).root, unique, 'sub', 'leaf');

    const grants = await guard.precheckAccess([deepMissing]);

    assert.deepStrictEqual(grants, [], 'must never offer the whole filesystem root');
  });

  it('TC-PG-005 (CHARACTERIZATION): with FS_ALLOWED_DIRS-style config and no ROOT_BOUNDARY, applyGrant silently drops the granted dir', async () => {
    // CHARACTERIZATION: plan 002 flips this — after the fix the granted dir MUST appear in getAllowedDirectories().
    const outOfRoot = await mkDir(createdDirs, 'fsmcp-pg005-');

    // No ROOT_BOUNDARY: isWithinBoundary returns true for everything, so the
    // grant is "accepted" but the subsequent recompute filters it back out
    // against the baseline (cliAllowedDirs only).
    delete process.env['ROOT_BOUNDARY'];
    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const grants = await guard.precheckAccess([outOfRoot]);
    assert.strictEqual(grants.length, 1, 'precheck should offer the out-of-root dir (no boundary)');

    const accepted = await guard.applyGrant(grants[0]!);
    assert.strictEqual(accepted, true, 'applyGrant reports success');

    // Pin the broken state: the granted dir is NOT actually present.
    const allowed = guard.getAllowedDirectories();
    assert.ok(
      !containsPath(allowed, outOfRoot),
      `granted dir "${outOfRoot}" must be absent in the current (buggy) behavior; ` +
        `allowed = ${JSON.stringify(allowed)}`,
    );
  });

  it('TC-PG-006: two concurrent applyGrant calls on different dirs both land', async () => {
    process.env['ROOT_BOUNDARY'] = tmpdir();
    const dir1 = await mkDir(createdDirs, 'fsmcp-pg006a-');
    const dir2 = await mkDir(createdDirs, 'fsmcp-pg006b-');

    const guard = new PathGuard({ cliAllowedDirs: [root] });
    await guard.recomputeAllowedDirectories();

    const [r1, r2] = await Promise.all([guard.applyGrant(dir1), guard.applyGrant(dir2)]);
    assert.strictEqual(r1, true, 'first grant should succeed');
    assert.strictEqual(r2, true, 'second grant should succeed');

    const allowed = guard.getAllowedDirectories();
    assert.ok(containsPath(allowed, dir1), `dir1 (${dir1}) should be in allowed dirs`);
    assert.ok(containsPath(allowed, dir2), `dir2 (${dir2}) should be in allowed dirs`);
  });
});

// Shared assertion helper for the write/delete block.
const assertAccessDenied = async (p: Promise<unknown>, msg: string): Promise<void> => {
  await assert.rejects(
    p,
    (err: unknown) => {
      assert(isFsError(err), `expected FsError, got ${String(err)}`);
      assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
      return true;
    },
    msg,
  );
};

// Some symlink creations need elevated privileges on Windows; skip those
// tests when the platform refuses. Mirrors TC-SEC-006 at security.test.ts:46.
// `type` is only honored on Windows: 'junction' for directory targets (no
// admin needed); 'file' for file symlinks (needs developer mode). On posix
// the type is ignored.
const trySymlink = async (
  target: string,
  linkPath: string,
  skip: () => void,
  type: 'junction' | 'file' | undefined = 'junction',
): Promise<boolean> => {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (err: unknown) {
    if (
      process.platform === 'win32' &&
      isNodeError(err) &&
      (err.code === 'EPERM' || err.code === 'EACCES')
    ) {
      skip();
      return false;
    }
    throw err;
  }
};

describe('Write/Delete PathGuard', () => {
  let root: string;
  let guard: PathGuard;

  beforeEach(async () => {
    root = await createTestRoot();
    guard = await PathGuard.fromAllowedDirectories([root]);
  });

  afterEach(async () => {
    if (root) await cleanupTestRoot(root);
  });

  it('TC-PG-007: validatePathForWrite denies when an ancestor symlink escapes the root', async (t) => {
    const linkPath = join(root, 'escape_link');
    const outsideTarget = tmpdir();
    if (!(await trySymlink(outsideTarget, linkPath, () => t.skip('symlink not permitted')))) return;

    const through = join(linkPath, 'newfile.txt');

    await assertAccessDenied(
      guard.validatePathForWrite(through),
      'should deny writing through a symlink that escapes the root',
    );
  });

  it('TC-PG-008: validatePathForWrite denies a sensitive target reached through an in-root symlink', async (t) => {
    const envPath = await writeTestFile(root, '.env', 'SECRET=1');
    const linkPath = join(root, 'link');
    // File symlink: 'file' type (junctions are directory-only on Win32 and
    // autodetect has been observed to create a broken dir-symlink to a file).
    if (!(await trySymlink(envPath, linkPath, () => t.skip('symlink not permitted'), 'file')))
      return;

    await assertAccessDenied(
      guard.validatePathForWrite(linkPath),
      'should deny writing through a symlink that resolves to a sensitive file',
    );
  });

  it('TC-PG-009: validatePathForDelete permits deleting an in-root symlink whose target is outside the root', async (t) => {
    const linkPath = join(root, 'escape_link');
    const outsideTarget = tmpdir();
    if (!(await trySymlink(outsideTarget, linkPath, () => t.skip('symlink not permitted')))) return;

    // Deleting the link itself is safe even though its target escapes.
    await assert.doesNotReject(
      guard.validatePathForDelete(linkPath),
      'should allow deleting a symlink regardless of its target',
    );
  });

  it('TC-PG-010: validatePathForDelete denies deleting a non-symlink whose realpath escapes the root', async (t) => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'fsmcp-pg010-'));
    const linkPath = join(root, 'escape_link');
    if (!(await trySymlink(outsideDir, linkPath, () => t.skip('symlink not permitted')))) return;
    // A real (non-symlink) file living under the symlinked ancestor. The
    // parent directory's realpath resolves through the symlink to outside
    // the root, so the delete is denied (the realpath escapes the root).
    await writeTestFile(outsideDir, 'target.txt', 'data');
    const through = join(linkPath, 'target.txt');
    try {
      await assertAccessDenied(
        guard.validatePathForDelete(through),
        'should deny deleting a non-symlink whose realpath escapes the root',
      );
    } finally {
      await cleanupTestRoot(outsideDir);
    }
  });
});