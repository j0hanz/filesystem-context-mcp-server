/**
 * Round-trip behavior for the access-grant SEP-2577 `input_required` flow.
 * Drives the registered READ handler directly: an out-of-root path returns
 * `input_required` (op:'grant') reading nothing (R7); an accepted retry grants
 * the target directory for the session and the read proceeds, and a second call
 * on the same path reads without re-prompting (R8); a retry whose grant set does
 * not match the verified state is rejected, so a grant for X cannot authorize Y
 * (R9). Mirrors the delete-file direct-handler stub pattern.
 */
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { READ_FILE } from '../../src/tools/read.js';
import { accept, registerAgainstStub, retryCtx, retryState } from '../helpers.js';

interface ReadResult {
  results?: { path?: string; value?: { content?: string } }[];
}
function readContentOf(raw: unknown): string | undefined {
  const sc = (raw as { structuredContent?: ReadResult }).structuredContent;
  return sc?.results?.[0]?.value?.content;
}

describe('access-grant input_required round-trip', () => {
  it('R7: an out-of-root read returns input_required and reads nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fsmcp-grant-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'fsmcp-grant-out-'));
    try {
      const file = join(outside, 'file.txt');
      await writeFile(file, 'secret-content', 'utf8');

      const handler = await registerAgainstStub(READ_FILE, root);
      const r1 = await handler({ path: file }, retryCtx());
      assert.ok(
        isInputRequiredResult(r1),
        'round 1 must return input_required for an out-of-root path',
      );
      assert.equal(readContentOf(r1), undefined, 'the out-of-root file is not read in round 1');

      const state = await retryState(r1);
      assert.equal(state.op, 'grant');
      assert.equal(state.paths.length, 1, 'state binds the single grant-target directory');
      assert.equal(state.paths[0]?.toLowerCase(), outside.toLowerCase());
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('R8: an accepted retry grants the dir and reads; a second call reads without re-prompting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fsmcp-grant-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'fsmcp-grant-out-'));
    try {
      const file = join(outside, 'file.txt');
      const content = 'grantable-content';
      await writeFile(file, content, 'utf8');

      const handler = await registerAgainstStub(READ_FILE, root);
      const r1 = await handler({ path: file }, retryCtx());
      assert.ok(isInputRequiredResult(r1));
      const state = await retryState(r1);

      // Accepted retry: the grant is applied and the read proceeds.
      const r2 = await handler({ path: file }, retryCtx({ responses: accept(), state }));
      assert.equal(isInputRequiredResult(r2), false, 'accepted retry does not round-trip again');
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(readContentOf(r2), content, 'the file is read once the grant is accepted');

      // Second call on the same path, fresh round (no state/responses): the dir
      // is now allowed for the session, so no re-prompt — it reads directly.
      const r3 = await handler({ path: file }, retryCtx());
      assert.equal(isInputRequiredResult(r3), false, 'an already-granted path does not re-prompt');
      assert.notEqual((r3 as { isError?: boolean }).isError, true);
      assert.equal(readContentOf(r3), content);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('R9: a grant accepted for X cannot authorize a retry naming Y', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fsmcp-grant-root-'));
    const outsideX = await mkdtemp(join(tmpdir(), 'fsmcp-grant-x-'));
    const outsideY = await mkdtemp(join(tmpdir(), 'fsmcp-grant-y-'));
    try {
      const fileX = join(outsideX, 'x.txt');
      const fileY = join(outsideY, 'y.txt');
      await writeFile(fileX, 'x-content', 'utf8');
      await writeFile(fileY, 'y-content', 'utf8');

      const handler = await registerAgainstStub(READ_FILE, root);
      // Round 1 grants outsideX; the state binds [outsideX].
      const r1 = await handler({ path: fileX }, retryCtx());
      assert.ok(isInputRequiredResult(r1));
      const state = await retryState(r1);
      assert.equal(state.paths[0]?.toLowerCase(), outsideX.toLowerCase());

      // Attacker retry: swap the args to fileY (grants outsideY) while echoing
      // outsideX's verified state. The grant set mismatch is rejected as a
      // tool error (isError), not a raw JSON-RPC error (GRANT-1 impact #2).
      const mismatch = (await handler(
        { path: fileY },
        retryCtx({ responses: accept(), state }),
      )) as { isError?: boolean; content?: { text?: string }[] };
      assert.equal(mismatch.isError, true, 'a mismatched grant retry is rejected as a tool error');
      assert.ok(
        mismatch.content?.[0]?.text?.includes('match the requested paths'),
        'error text names the mismatch',
      );

      // Neither directory was granted: Y still prompts on a fresh call (X does
      // too, but Y is the falsifier — a leaked grant would read it here).
      const r3 = await handler({ path: fileY }, retryCtx());
      assert.ok(isInputRequiredResult(r3), 'Y was not granted by X’s confirmation');
      assert.equal(readContentOf(r3), undefined, 'Y is not read without its own grant');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outsideX, { recursive: true, force: true });
      await rm(outsideY, { recursive: true, force: true });
    }
  });
});
