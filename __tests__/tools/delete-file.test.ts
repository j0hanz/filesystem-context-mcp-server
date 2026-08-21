/**
 * Round-trip + atomic-batch behavior for the delete tool's SEP-2577
 * `input_required` confirmation flow. Drives the registered handler directly
 * (the SDK seam is exercised in the infra test): a first round carries no
 * `inputResponses`/`requestState` and must return `input_required` deleting
 * nothing; the retry carries the accepted confirmation and the verified state.
 * Covers R3 (accept), R4 (decline→CANCELLED), R5 (cancel/missing→cancelled),
 * R6 (fail-closed no-retry), R9 (state↔paths mismatch rejects), R13 (no
 * confirmation ⇒ no round-trip), R14 (batch atomicity).
 */
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DELETE_FILE } from '../../src/tools/delete-file.js';
import {
  accept,
  createTestEnv,
  getStructured,
  registerAgainstStub,
  retryCtx,
  retryState,
  trySymlink,
} from '../helpers.js';

interface StructuredDelete {
  ok?: boolean;
  path?: string;
  paths?: string[];
  failures?: { path?: string; error?: { code?: string; message?: string } }[];
}

function structuredOf(raw: unknown): StructuredDelete {
  return (raw as { structuredContent?: StructuredDelete }).structuredContent ?? {};
}

describe('delete input_required round-trip', () => {
  it('R3: non-empty recursive dir round-trips to deletion on accept', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-accept-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      await writeFile(join(dir, 'file.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [dir], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'round 1 must return input_required');
      assert.ok(existsSync(dir), 'nothing is deleted in round 1');

      const state = await retryState(r1);
      const r2 = await handler(
        { paths: [dir], recursive: true },
        retryCtx({ responses: accept(), state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(structuredOf(r2).ok, true);
      assert.equal(existsSync(dir), false, 'dir is deleted on accepted retry');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R4: a declined retry leaves the dir and reports CANCELLED', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-decline-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      await writeFile(join(dir, 'file.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [dir], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1));
      const state = await retryState(r1);

      const r2 = await handler(
        { paths: [dir], recursive: true },
        retryCtx({ responses: { confirm_0: { action: 'decline' } }, state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      const sc = structuredOf(r2);
      assert.equal(sc.ok, false);
      assert.equal(sc.failures?.[0]?.error?.code, 'CANCELLED');
      assert.ok(existsSync(dir), 'dir survives a declined retry');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R5: a cancelled retry and a missing-key retry both report CANCELLED', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-cancel-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      await writeFile(join(dir, 'file.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [dir], recursive: true }, retryCtx());
      const state = await retryState(r1);

      const cancelled = await handler(
        { paths: [dir], recursive: true },
        retryCtx({ responses: { confirm_0: { action: 'cancel' } }, state }),
      );
      assert.equal(structuredOf(cancelled).failures?.[0]?.error?.code, 'CANCELLED');
      assert.ok(existsSync(dir));

      // Missing key entirely (no responses) — still a declined/cancelled outcome.
      const missing = await handler({ paths: [dir], recursive: true }, retryCtx({ state }));
      assert.equal(structuredOf(missing).failures?.[0]?.error?.code, 'CANCELLED');
      assert.ok(existsSync(dir));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R6: with no retry, a pending dir is never deleted (fail-closed)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-noretry-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      await writeFile(join(dir, 'file.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [dir], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'round 1 returns input_required, not a silent proceed');
      assert.ok(existsSync(dir), 'a non-retrying client deletes nothing');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R14: a mixed [file, nonEmptyDir] batch deletes nothing in round 1, both on accept', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-batch-'));
    try {
      const file = join(tmp, 'file.txt');
      const dir = join(tmp, 'dir');
      await writeFile(file, 'content', 'utf8');
      await mkdir(dir);
      await writeFile(join(dir, 'inside.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [file, dir], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'any pending item forces a round-trip');
      assert.ok(existsSync(file), 'atomic: the file is untouched in round 1');
      assert.ok(existsSync(dir), 'atomic: the dir is untouched in round 1');

      const state = await retryState(r1);
      assert.equal(state.op, 'delete');
      assert.equal(state.paths.length, 1, 'state binds only the pending dir');
      assert.equal(state.paths[0]?.toLowerCase(), dir.toLowerCase());
      const r2 = await handler(
        { paths: [file, dir], recursive: true },
        retryCtx({ responses: accept(), state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(structuredOf(r2).ok, true);
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(dir), false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R13: a plain file (no confirmation needed) deletes in one round', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-noconfirm-'));
    try {
      const file = join(tmp, 'file.txt');
      await writeFile(file, 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [file] }, retryCtx());
      assert.equal(isInputRequiredResult(r1), false, 'a non-pending delete does not round-trip');
      assert.notEqual((r1 as { isError?: boolean }).isError, true);
      assert.equal(structuredOf(r1).ok, true);
      assert.equal(existsSync(file), false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R9: a retry whose pending paths do not match the state is rejected', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-mismatch-'));
    try {
      const dirA = join(tmp, 'dir-a');
      const dirB = join(tmp, 'dir-b');
      await mkdir(dirA);
      await writeFile(join(dirA, 'f.txt'), 'x', 'utf8');
      await mkdir(dirB);
      await writeFile(join(dirB, 'f.txt'), 'x', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      // Round 1 confirms dirA; the state binds [dirA].
      const r1 = await handler({ paths: [dirA], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1));
      const state = await retryState(r1);

      // Attacker retry: swap the args to dirB while echoing dirA's state.
      const r2 = await handler(
        { paths: [dirB], recursive: true },
        retryCtx({ responses: accept(), state }),
      );
      assert.equal((r2 as { isError?: boolean }).isError, true, 'mismatched retry is rejected');
      assert.ok(existsSync(dirA), 'dirA is not deleted by a swapped retry');
      assert.ok(existsSync(dirB), 'dirB is not deleted without its own confirmation');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R2: two pending dirs round-trip as one input_required with two confirmations', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-two-'));
    try {
      const dirA = join(tmp, 'dir-a');
      const dirB = join(tmp, 'dir-b');
      await mkdir(dirA);
      await writeFile(join(dirA, 'f.txt'), 'x', 'utf8');
      await mkdir(dirB);
      await writeFile(join(dirB, 'f.txt'), 'x', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [dirA, dirB], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'two pending dirs force a round-trip');
      assert.ok(existsSync(dirA), 'dirA untouched in round 1');
      assert.ok(existsSync(dirB), 'dirB untouched in round 1');

      const state = await retryState(r1);
      assert.equal(state.op, 'delete');
      assert.equal(state.paths.length, 2, 'state binds both pending dirs');

      const r1WithRequests = r1 as { inputRequests?: Record<string, unknown> };
      assert.deepEqual(
        Object.keys(r1WithRequests.inputRequests ?? {}).sort(),
        ['confirm_0', 'confirm_1'],
        'one confirmation per pending dir',
      );

      const r2 = await handler(
        { paths: [dirA, dirB], recursive: true },
        retryCtx({
          responses: {
            confirm_0: { action: 'accept', content: { confirm: true } },
            confirm_1: { action: 'accept', content: { confirm: true } },
          },
          state,
        }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(structuredOf(r2).ok, true);
      assert.equal(existsSync(dirA), false, 'dirA deleted on accepted retry');
      assert.equal(existsSync(dirB), false, 'dirB deleted on accepted retry');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R12: a malformed retry response does not perform the delete', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-del-malformed-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      await writeFile(join(dir, 'file.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const r1 = await handler({ paths: [dir], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1));
      const state = await retryState(r1);

      // Accept action with no `confirm` field — malformed: readAcceptedConfirm
      // returns false, so the item reports CANCELLED rather than proceeding.
      const r2 = await handler(
        { paths: [dir], recursive: true },
        retryCtx({
          responses: { confirm_0: { action: 'accept', content: {} } } as unknown as Record<
            string,
            unknown
          >,
          state,
        }),
      );
      assert.ok(existsSync(dir), 'malformed responses do not perform the delete');
      const sc = structuredOf(r2);
      assert.ok(!(sc.ok === true), 'a malformed retry does not succeed');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
describe('delete: sensitive-file denial survives the ENOENT fallback', () => {
  it('blocks deleting .aws/credentials reached through a symlinked parent', async (t) => {
    const env = await createTestEnv();
    try {
      const awsDir = join(env.tmpDir, '.aws');
      await mkdir(awsDir);
      const secret = join(awsDir, 'credentials');
      await writeFile(secret, 'placeholder');

      const linkDir = join(env.tmpDir, 'cfg');
      if (!(await trySymlink(awsDir, linkDir, 'dir'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      const result = await env.client.callTool({
        name: 'delete',
        arguments: { paths: [join(linkDir, 'credentials')] },
      });

      const sc = getStructured(result);
      assert.equal(sc['ok'], false, 'delete must report failure for a denylisted target');
      const failures = sc['failures'] as { error: { code: string } }[];
      assert.equal(failures[0]?.error.code, 'ACCESS_DENIED');
      // The decisive assertion: the file is still on disk.
      await stat(secret);
    } finally {
      await env.cleanup();
    }
  });
});
