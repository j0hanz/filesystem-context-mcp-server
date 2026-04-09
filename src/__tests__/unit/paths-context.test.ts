import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { ErrorCode, McpError } from '../../lib/errors.js';
import {
  getAllowedDirectories,
  normalizePath,
  resolveAllowedDirectoriesState,
  setAllowedDirectoriesResolved,
  validateExistingDirectory,
  withAllowedDirectoriesState,
} from '../../lib/paths.js';

describe('allowed directories async context', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await setAllowedDirectoriesResolved([]);
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('isolates path validation within an async context override', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'fsmcp-root-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'fsmcp-root-b-'));
    tempDirs.push(dirA, dirB);

    await setAllowedDirectoriesResolved([dirA]);
    const stateB = await resolveAllowedDirectoriesState([dirB]);
    const normalizedDirA = normalizePath(dirA);
    const normalizedDirB = normalizePath(dirB);

    const result = await withAllowedDirectoriesState(stateB, async () => {
      assert.deepEqual(getAllowedDirectories(), [normalizedDirB]);

      const validDir = await validateExistingDirectory(normalizedDirB);
      let deniedError: unknown;
      try {
        await validateExistingDirectory(normalizedDirA);
      } catch (error) {
        deniedError = error;
      }

      return { deniedError, validDir };
    });

    assert.equal(result.validDir, normalizedDirB);
    assert.ok(result.deniedError instanceof McpError);
    assert.equal(result.deniedError.code, ErrorCode.ACCESS_DENIED);

    assert.deepEqual(getAllowedDirectories(), [normalizedDirA]);
    await assert.doesNotReject(() => validateExistingDirectory(normalizedDirA));
  });

  it('keeps concurrent async contexts separated', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'fsmcp-root-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'fsmcp-root-b-'));
    tempDirs.push(dirA, dirB);

    const stateA = await resolveAllowedDirectoriesState([dirA]);
    const stateB = await resolveAllowedDirectoriesState([dirB]);
    const normalizedDirA = normalizePath(dirA);
    const normalizedDirB = normalizePath(dirB);

    const [dirsA, dirsB] = await Promise.all([
      withAllowedDirectoriesState(stateA, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getAllowedDirectories();
      }),
      withAllowedDirectoriesState(stateB, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getAllowedDirectories();
      }),
    ]);

    assert.deepEqual(dirsA, [normalizedDirA]);
    assert.deepEqual(dirsB, [normalizedDirB]);
  });
});
