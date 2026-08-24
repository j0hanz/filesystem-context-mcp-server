import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode, isFsError, isNodeError } from '../src/core/errors.js';
import { PathGuard } from '../src/core/path.js';
import { SensitiveMatcher } from '../src/core/sensitive.js';
import { cleanupTestRoot, createTestRoot, writeTestFile } from './helpers.js';

describe('Security (P0)', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTestRoot();
  });

  afterEach(async () => {
    if (root) {
      await cleanupTestRoot(root);
    }
  });

  describe('PathGuard boundary enforcement', () => {
    let guard: PathGuard;

    beforeEach(async () => {
      guard = await PathGuard.fromAllowedDirectories([root]);
    });

    it('TC-SEC-005: Blocks directory traversal via ..', async () => {
      const traversePath = join(root, '..', '..', '..', 'etc', 'passwd');

      await assert.rejects(
        guard.validateExistingPath(traversePath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject traversal outside allowed root',
      );
    });

    it('TC-SEC-006: Blocks symlink escape', async () => {
      const linkPath = join(root, 'escape_link');
      const outsideTarget = tmpdir();

      try {
        await symlink(outsideTarget, linkPath, 'junction');
      } catch (err: unknown) {
        if (
          process.platform === 'win32' &&
          isNodeError(err) &&
          (err.code === 'EPERM' || err.code === 'EACCES')
        ) {
          return;
        }
        throw err;
      }

      await assert.rejects(
        guard.validateExistingPath(linkPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject paths accessed through a symlink escaping the root',
      );
    });

    it('TC-SEC-007: Blocks absolute path outside root', async () => {
      const outsidePath = resolve(tmpdir(), 'some-other-dir', 'file.txt');

      await assert.rejects(
        guard.validateExistingPath(outsidePath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject absolute paths completely outside the root',
      );
    });

    it('TC-SEC-008: Blocks access to sensitive file .env', async () => {
      const envPath = await writeTestFile(root, '.env', 'SECRET=1');

      await assert.rejects(
        guard.validateExistingPath(envPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject access to .env',
      );
    });

    it('TC-SEC-009: Blocks access to sensitive file *.pem', async () => {
      const pemPath = await writeTestFile(root, 'server.pem', 'KEY');

      await assert.rejects(
        guard.validateExistingPath(pemPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject access to *.pem',
      );
    });

    it('TC-SEC-010: Blocks access to sensitive file *id_rsa*', async () => {
      const rsaPath = await writeTestFile(root, 'id_rsa', 'KEY');

      await assert.rejects(
        guard.validateExistingPath(rsaPath),
        (err) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);
          return true;
        },
        'Should reject access to id_rsa',
      );
    });
  });

  describe('SensitiveMatcher directly', () => {
    it('TC-SEC-011: Prevents NTFS ADS bypass attempt', (t) => {
      const matcher = new SensitiveMatcher();
      if (process.platform !== 'win32') {
        t.skip('NTFS ADS stripping is Windows-only');
        return;
      }
      assert.strictEqual(matcher.isSensitive('.env:stream'), true);
    });

    it('TC-SEC-012: ALLOW_SENSITIVE=1 override allows sensitive files', () => {
      const matcher = new SensitiveMatcher([]);
      assert.strictEqual(
        matcher.isSensitive('.env'),
        false,
        'Should allow .env when patterns are empty',
      );
      assert.strictEqual(matcher.isSensitive('server.pem'), false);
    });

    it('TC-SEC-013: Custom DENYLIST rules', () => {
      const matcher = new SensitiveMatcher(['*.secret']);
      assert.strictEqual(matcher.isSensitive('data.secret'), true, 'Should match custom pattern');
      assert.strictEqual(
        matcher.isSensitive('data.txt'),
        false,
        'Should not match unrelated files',
      );
    });
  });

  describe('SensitiveMatcher directly (extended)', () => {
    it('TC-SENS-001: path-glob pattern matches under any parent via **/ prefix', () => {
      const matcher = new SensitiveMatcher(['.aws/credentials']);
      assert.strictEqual(
        matcher.isSensitive('/home/u/.aws/credentials'),
        true,
        'non-rooted path pattern should match under any parent via **/ prefix',
      );
    });

    it('TC-SENS-002: path-glob pattern does not match a sibling of the pattern dir', () => {
      const matcher = new SensitiveMatcher(['.aws/credentials']);
      assert.strictEqual(
        matcher.isSensitive('/home/u/other'),
        false,
        'should not match an unrelated path',
      );
    });

    it('TC-SENS-003: rooted path glob does NOT get the **/ prefix', () => {
      const matcher = new SensitiveMatcher(['/abs/path/secret']);
      assert.strictEqual(
        matcher.isSensitive('/abs/path/secret'),
        true,
        'rooted pattern should match the exact absolute path',
      );
      assert.strictEqual(
        matcher.isSensitive('other/secret'),
        false,
        'rooted pattern must NOT match via **/ prefix on unrelated parents',
      );
    });

    it('TC-SENS-004: default .mcpregistry_*_token pattern matches', () => {
      const matcher = new SensitiveMatcher();
      assert.strictEqual(
        matcher.isSensitive('.mcpregistry_github_token'),
        true,
        'default .mcpregistry_*_token pattern should match',
      );
    });

    it('TC-SENS-005: trailing dot/space is trimmed before matching on Windows', (t) => {
      if (process.platform !== 'win32') {
        t.skip('trailing dot/space trim is Windows-only (Win32 syscall boundary)');
        return;
      }
      const matcher = new SensitiveMatcher();
      // Win32 strips trailing dots/spaces at the syscall boundary, so ".env "
      // and ".env." create ".env". The matcher trims before denylist matching
      // or the exact-name patterns are bypassed.
      assert.strictEqual(matcher.isSensitive('.env '), true, '".env " should be caught as ".env"');
      assert.strictEqual(matcher.isSensitive('.env.'), true, '".env." should be caught as ".env"');
    });
  });
});
