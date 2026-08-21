// __tests__/tools/elicitation.test.ts
//
// Round-trip coverage for the access-grant half of the SEP-2577 `input_required`
// flow that is NOT already covered by the dedicated suites: the grant-DECLINED
// path (access-grant.test.ts covers accept/R7/R8/R9; decline failing closed with
// ACCESS_DENIED and NOT persisting a grant is unique here) and the ROOT_BOUNDARY
// gate (an out-of-root path outside the boundary is ungrantable, so it is never
// prompted — it fails ACCESS_DENIED directly). The delete/move accept/decline/
// no-capability/throw cases live in delete-file.test.ts, move.test.ts, and
// elicitation-era.test.ts; this file drives the registered READ handler directly
// because the multi-round-trip cannot be simulated over the wire harness.
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { READ_FILE } from '../../src/tools/read.js';
import { registerAgainstStub, retryCtx, retryState } from '../helpers.js';

interface ReadResult {
  results?: { path?: string; value?: { content?: string }; error?: { code?: string } }[];
}
function readResultOf(raw: unknown): ReadResult['results'] {
  return (raw as { structuredContent?: ReadResult }).structuredContent?.results;
}

describe('access grant declined (input_required round-trip)', () => {
  it('a declined grant fails ACCESS_DENIED and does not persist the grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fsmcp-decline-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'fsmcp-decline-out-'));
    try {
      const file = join(outside, 'file.txt');
      await writeFile(file, 'no-access-content', 'utf8');

      const handler = await registerAgainstStub(READ_FILE, root, async (pg, r) => pg.setRoots([r]));
      const r1 = await handler({ path: file }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'round 1 prompts for the out-of-root grant');
      const state = await retryState(r1);

      // Declined retry: the grant is NOT applied, so the read fails ACCESS_DENIED.
      const r2 = await handler(
        { path: file },
        retryCtx({ responses: { confirm_0: { action: 'decline' } }, state }),
      );
      assert.equal(isInputRequiredResult(r2), false, 'declined retry does not round-trip again');
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      const err2 = readResultOf(r2)?.[0]?.error;
      assert.equal(err2?.code, 'ACCESS_DENIED', 'declined grant fails closed with ACCESS_DENIED');

      // A fresh call still prompts — the decline persisted no grant.
      const r3 = await handler({ path: file }, retryCtx());
      assert.ok(isInputRequiredResult(r3), 'a declined grant does not authorize later calls');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('ROOT_BOUNDARY blocks an ungrantable out-of-root path', () => {
  const ORIG_BOUNDARY = process.env['ROOT_BOUNDARY'];

  it('fails ACCESS_DENIED without prompting when the path is outside ROOT_BOUNDARY', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-bound-'));
    const boundaryDir = join(tempDir, 'boundary');
    const outsideDir = join(tempDir, 'outside');
    await mkdir(boundaryDir);
    await mkdir(outsideDir);
    const fileOutside = join(outsideDir, 'secret.txt');
    await writeFile(fileOutside, 'should remain blocked', 'utf8');
    try {
      // The allowed root is inside the boundary; the requested file is outside
      // both the root and the boundary → ungrantable → no input_required prompt.
      process.env['ROOT_BOUNDARY'] = boundaryDir;
      const root = join(boundaryDir, 'workspace');
      await mkdir(root);
      const handler = await registerAgainstStub(READ_FILE, root, async (pg, r) => pg.setRoots([r]));

      const r1 = await handler({ path: fileOutside }, retryCtx());
      assert.equal(
        isInputRequiredResult(r1),
        false,
        'an ungrantable out-of-boundary path is not prompted for a grant',
      );
      assert.notEqual((r1 as { isError?: boolean }).isError, true);
      const err = readResultOf(r1)?.[0]?.error;
      assert.ok(err, 'Expected an error result for an out-of-boundary path');
      assert.equal(err?.code, 'ACCESS_DENIED');
      // The boundary env is restored in finally; the file is cleaned via tempDir.
    } finally {
      if (ORIG_BOUNDARY === undefined) {
        delete process.env['ROOT_BOUNDARY'];
      } else {
        process.env['ROOT_BOUNDARY'] = ORIG_BOUNDARY;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
