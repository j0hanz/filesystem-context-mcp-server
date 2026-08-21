/**
 * Integration tests for the move tool.
 */
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MOVE } from '../../src/tools/move.js';
import { trySymlink } from '../helpers.js';
import {
  accept,
  assertOk,
  createTestEnv,
  createTestEnvWithElicitation,
  getStructured,
  registerAgainstStub,
  retryCtx,
  retryState,
  type TestEnv,
} from '../helpers.js';

describe('move tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('rejects moving directory into case-variant subdirectory on case-insensitive systems', async () => {
    const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    if (!isCaseInsensitive) {
      return; // Skip on case-sensitive systems (or adapt test)
    }

    const sourceDir = join(env.tmpDir, 'MySource');
    const targetInSource = join(env.tmpDir, 'mysource', 'nested'); // Case variant 'mysource' vs 'MySource'

    await mkdir(sourceDir, { recursive: true });

    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        moves: [
          {
            source: sourceDir,
            destination: targetInSource,
          },
        ],
      },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    const failures = sc['failures'] as { error: { code: string; message: string } }[];
    assert.ok(Array.isArray(failures));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].error.code, 'INVALID_INPUT');
    assert.match(failures[0].error.message, /subdirectory/);
  });

  it('performs a case-only rename with no overwrite confirmation on darwin', async () => {
    // Genuine case-only rename (Foo.txt -> foo.txt): isSamePath must treat the
    // two as the same path so move skips the overwrite-confirmation elicit. The
    // darwin fold landed in Step 11; before it, isSamePath was Windows-only.
    //
    // Gated to darwin only: on win32 the move tool no-ops a case-only rename —
    // move.ts:248 resolves the destination to the source's actual on-disk
    // casing, so `resolvedSource === resolvedDest` continues before any rename
    // (verified empirically: `moves: []`, no failure). That no-op is pre-existing
    // move.ts behavior, out of Step 11's scope (no move.ts change). CI has no
    // macOS runner (ci.yml runs ubuntu/windows only), so this self-verifies on a
    // real Mac locally; the win32 leg is covered by the case-variant test above.
    if (process.platform !== 'darwin') return;

    const e = await createTestEnvWithElicitation(async () => {
      assert.fail('overwrite confirmation must not elicit for a case-only rename');
    });
    try {
      const src = join(e.tmpDir, 'Foo.txt');
      await writeFile(src, 'content');
      const dest = join(e.tmpDir, 'foo.txt');

      const raw = await e.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dest }] },
      });
      assertOk(raw);
      const sc = getStructured(raw);
      assert.equal(sc['ok'], true);
      const moves = sc['moves'] as { ok: boolean }[];
      assert.equal(moves.length, 1, 'must be a single rename, not an overwrite flow');

      const entries = await readdir(e.tmpDir);
      assert.ok(entries.includes('foo.txt'), 'file must be renamed to lowercase on disk');
      assert.ok(!entries.includes('Foo.txt'), 'original casing must be gone');
    } finally {
      await e.cleanup();
    }
  });
});

// ── direct-handler round-trip (SEP-2577 input_required) ──────────────────────

interface StructuredMove {
  ok?: boolean;
  moves?: { from?: string; to?: string }[];
  failures?: { source?: string; destination?: string; error?: { code?: string } }[];
}

function structuredOf(raw: unknown): StructuredMove {
  return (raw as { structuredContent?: StructuredMove }).structuredContent ?? {};
}

describe('move input_required round-trip', () => {
  it('R3: an overwrite round-trips to a moved file on accept', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-move-accept-'));
    try {
      const source = join(tmp, 'src.txt');
      const dest = join(tmp, 'dest.txt');
      await writeFile(source, 'source content', 'utf8');
      await writeFile(dest, 'original dest', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const r1 = await handler({ moves: [{ source, destination: dest }] }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'existing dest forces a round-trip');
      assert.equal(await readFile(dest, 'utf8'), 'original dest', 'dest untouched in round 1');
      assert.ok(existsSync(source), 'source untouched in round 1');

      const state = await retryState(r1);
      const r2 = await handler(
        { moves: [{ source, destination: dest }] },
        retryCtx({ responses: accept(), state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(await readFile(dest, 'utf8'), 'source content', 'dest overwritten on accept');
      assert.equal(existsSync(source), false, 'source gone after the move');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R4: a declined retry leaves dest and source and reports CANCELLED', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-move-decline-'));
    try {
      const source = join(tmp, 'src.txt');
      const dest = join(tmp, 'dest.txt');
      await writeFile(source, 'source content', 'utf8');
      await writeFile(dest, 'original dest', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const r1 = await handler({ moves: [{ source, destination: dest }] }, retryCtx());
      assert.ok(isInputRequiredResult(r1));
      const state = await retryState(r1);

      const r2 = await handler(
        { moves: [{ source, destination: dest }] },
        retryCtx({ responses: { confirm_0: { action: 'decline' } }, state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      const sc = structuredOf(r2);
      assert.equal(sc.failures?.[0]?.error?.code, 'CANCELLED');
      assert.equal(await readFile(dest, 'utf8'), 'original dest', 'dest survives a decline');
      assert.ok(existsSync(source), 'source survives a decline');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R14: a mixed [overwrite, fresh] batch moves nothing in round 1, both on accept', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-move-batch-'));
    try {
      const srcA = join(tmp, 'a.txt');
      const destA = join(tmp, 'existing.txt'); // overwrite
      const srcB = join(tmp, 'b.txt');
      const destB = join(tmp, 'fresh.txt'); // fresh
      await writeFile(srcA, 'A', 'utf8');
      await writeFile(destA, 'original', 'utf8');
      await writeFile(srcB, 'B', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const r1 = await handler(
        {
          moves: [
            { source: srcA, destination: destA },
            { source: srcB, destination: destB },
          ],
        },
        retryCtx(),
      );
      assert.ok(isInputRequiredResult(r1), 'any overwrite forces a round-trip');
      assert.ok(existsSync(srcA), 'atomic: overwrite source untouched in round 1');
      assert.equal(await readFile(destA, 'utf8'), 'original', 'atomic: existing dest untouched');
      assert.ok(existsSync(srcB), 'atomic: fresh source untouched in round 1');
      assert.equal(existsSync(destB), false, 'atomic: fresh dest not created in round 1');

      const state = await retryState(r1);
      assert.equal(state.op, 'move');
      assert.equal(state.paths.length, 1, 'state binds only the overwrite dest');
      const r2 = await handler(
        {
          moves: [
            { source: srcA, destination: destA },
            { source: srcB, destination: destB },
          ],
        },
        retryCtx({ responses: accept(), state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(await readFile(destA, 'utf8'), 'A');
      assert.equal(await readFile(destB, 'utf8'), 'B');
      assert.equal(existsSync(srcA), false);
      assert.equal(existsSync(srcB), false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('R2: two overwrites round-trip as one input_required with two confirmations', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-move-two-'));
    try {
      const srcA = join(tmp, 'a.txt');
      const destA = join(tmp, 'existing-a.txt');
      const srcB = join(tmp, 'b.txt');
      const destB = join(tmp, 'existing-b.txt');
      await writeFile(srcA, 'A', 'utf8');
      await writeFile(destA, 'original-a', 'utf8');
      await writeFile(srcB, 'B', 'utf8');
      await writeFile(destB, 'original-b', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const r1 = await handler(
        {
          moves: [
            { source: srcA, destination: destA },
            { source: srcB, destination: destB },
          ],
        },
        retryCtx(),
      );
      assert.ok(isInputRequiredResult(r1), 'two overwrites force a round-trip');
      assert.equal(await readFile(destA, 'utf8'), 'original-a', 'destA untouched in round 1');
      assert.equal(await readFile(destB, 'utf8'), 'original-b', 'destB untouched in round 1');

      const state = await retryState(r1);
      assert.equal(state.op, 'move');
      assert.equal(state.paths.length, 2, 'state binds both overwrite dests');

      const r1WithRequests = r1 as { inputRequests?: Record<string, unknown> };
      assert.deepEqual(
        Object.keys(r1WithRequests.inputRequests ?? {}).sort(),
        ['confirm_0', 'confirm_1'],
        'one confirmation per overwrite',
      );

      const r2 = await handler(
        {
          moves: [
            { source: srcA, destination: destA },
            { source: srcB, destination: destB },
          ],
        },
        retryCtx({
          responses: {
            confirm_0: { action: 'accept', content: { confirm: true } },
            confirm_1: { action: 'accept', content: { confirm: true } },
          },
          state,
        }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(await readFile(destA, 'utf8'), 'A');
      assert.equal(await readFile(destB, 'utf8'), 'B');
      assert.equal(existsSync(srcA), false);
      assert.equal(existsSync(srcB), false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects a second source targeting a destination already claimed in the same batch', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-move-dupdest-'));
    try {
      const sourceA = join(tmp, 'source-a.txt');
      const sourceB = join(tmp, 'source-b.txt');
      const dest = join(tmp, 'dest.txt');
      await writeFile(sourceA, 'content-a', 'utf8');
      await writeFile(sourceB, 'content-b', 'utf8');
      await writeFile(dest, 'original', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const moves = [
        { source: sourceA, destination: dest },
        { source: sourceB, destination: dest },
      ];
      const r1 = await handler({ moves }, retryCtx());
      assert.ok(
        isInputRequiredResult(r1),
        'the first plan for the shared dest still needs overwrite confirmation',
      );
      const state = await retryState(r1);
      assert.equal(state.paths.length, 1, 'only the first plan reaches the pending overwrite set');

      const r2 = await handler({ moves }, retryCtx({ responses: accept(), state }));
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      const sc = structuredOf(r2);

      assert.equal(sc.moves?.length, 1, 'exactly one of the two moves succeeds');
      assert.equal(sc.moves?.[0]?.from?.toLowerCase(), sourceA.toLowerCase());

      assert.equal(
        sc.failures?.length,
        1,
        'the duplicate-destination move is reported as a failure',
      );
      assert.equal(sc.failures?.[0]?.source, sourceB);
      assert.equal(sc.failures?.[0]?.error?.code, 'INVALID_INPUT');

      // The destination was NOT overwritten a second time by the rejected duplicate.
      assert.equal(await readFile(dest, 'utf8'), 'content-a');
      assert.equal(existsSync(sourceA), false, 'the winning source is gone after the move');
      assert.ok(existsSync(sourceB), 'the rejected duplicate source is left in place');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('a chained grant + overwrite confirmation completes across three rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fsmcp-move-chain-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'fsmcp-move-chain-out-'));
    try {
      const source = join(root, 'src.txt');
      const dest = join(outside, 'dest.txt'); // out-of-root AND already exists
      await writeFile(source, 'new content', 'utf8');
      await writeFile(dest, 'original', 'utf8');

      const handler = await registerAgainstStub(MOVE, root);

      // Round 1: precheckGrant runs before move's own logic — the grant round
      // fires first (the destination's parent, `outside`, is the grant target).
      const r1 = await handler({ moves: [{ source, destination: dest }] }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'round 1 returns input_required for the access grant');
      const state1 = await retryState(r1);
      assert.equal(state1.op, 'grant');
      assert.equal(
        await readFile(dest, 'utf8'),
        'original',
        'nothing moved while the grant is pending',
      );

      // Round 2: the grant is applied; move's own overwrite-confirmation round
      // must now present its OWN input_required, not throw INVALID_INPUT for
      // the (already-resolved) grant state.
      const r2 = await handler(
        { moves: [{ source, destination: dest }] },
        retryCtx({ responses: accept(), state: state1 }),
      );
      assert.equal(
        isInputRequiredResult(r2),
        true,
        'round 2 must present the overwrite confirmation, not error',
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      const state2 = await retryState(r2);
      assert.equal(state2.op, 'move');
      assert.equal(
        await readFile(dest, 'utf8'),
        'original',
        'nothing moved while the overwrite confirmation is pending',
      );

      // Round 3: accept the overwrite — the grant from round 1 is still in
      // effect, and the move completes.
      const r3 = await handler(
        { moves: [{ source, destination: dest }] },
        retryCtx({ responses: accept(), state: state2 }),
      );
      assert.notEqual((r3 as { isError?: boolean }).isError, true);
      assert.equal(
        await readFile(dest, 'utf8'),
        'new content',
        'the out-of-root dest is overwritten after both confirmations',
      );
      assert.equal(existsSync(source), false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('R13: a move to a fresh destination completes in one round', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-move-fresh-'));
    try {
      const source = join(tmp, 'src.txt');
      const dest = join(tmp, 'dest.txt');
      await writeFile(source, 'content', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const r1 = await handler({ moves: [{ source, destination: dest }] }, retryCtx());
      assert.equal(isInputRequiredResult(r1), false, 'no overwrite ⇒ no round-trip');
      assert.notEqual((r1 as { isError?: boolean }).isError, true);
      assert.equal(await readFile(dest, 'utf8'), 'content');
      assert.equal(existsSync(source), false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('move: renames the symlink, not its target', () => {
  it('leaves the target in place and moves the link itself', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'data.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      assertOk(
        await env.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: link, destination: join(env.tmpDir, 'moved.txt') }] },
        }),
      );

      // The target must not have been renamed out from under the link.
      assert.equal(await readFile(target, 'utf-8'), 'payload');
      const moved = await lstat(join(env.tmpDir, 'moved.txt'));
      assert.ok(moved.isSymbolicLink(), 'the moved entry must still be a symlink');
    } finally {
      await env.cleanup();
    }
  });

  it('skips a self-move of a symlink instead of renaming it over its target', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'data.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      assertOk(
        await env.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: link, destination: link }] },
        }),
      );

      assert.equal(
        await readFile(target, 'utf-8'),
        'payload',
        'self-move must not touch the target',
      );
      assert.ok((await lstat(link)).isSymbolicLink(), 'the link must survive a self-move');
    } finally {
      await env.cleanup();
    }
  });

  it('skips moving a symlink onto its own target', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'data.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      assertOk(
        await env.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: link, destination: target }] },
        }),
      );

      // Renaming the link over data.txt would destroy the payload and leave a
      // self-referential link.
      assert.equal(await readFile(target, 'utf-8'), 'payload');
      assert.equal((await lstat(target)).isSymbolicLink(), false);
    } finally {
      await env.cleanup();
    }
  });
});
