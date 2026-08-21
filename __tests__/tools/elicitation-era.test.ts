/**
 * The 2026-07-28 protocol era removed push-style server->client requests, so
 * destructive confirmation no longer goes through a throwing `elicitInput`;
 * it returns an `input_required` result the client retries with
 * `inputResponses`. On a connection that offers no elicitation capability the
 * behavior is identical: a destructive call returns `input_required` (not a
 * throw, not a silent proceed) and the filesystem is untouched until an
 * accepted retry (R6 fail-closed). These drive the registered handler directly
 * — the wire-level handler cannot simulate the round-trip — supplying
 * `mcpReq.inputResponses` and a verified `requestState` across two calls.
 */
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { DELETE_FILE } from '../../src/tools/delete-file.js';
import { MOVE } from '../../src/tools/move.js';
import { accept, registerAgainstStub, retryCtx, retryState } from '../helpers.js';

describe('elicitation on a 2026-07-28 connection', () => {
  it('delete: a non-empty dir returns input_required and is untouched until an accepted retry', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-era-delete-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      const file = join(dir, 'file.txt');
      await writeFile(file, 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);

      // Round 1: no capability to be asked → input_required, nothing deleted (R6).
      const r1 = await handler({ paths: [dir], recursive: true }, retryCtx());
      assert.ok(isInputRequiredResult(r1), 'round 1 returns input_required, not a silent proceed');
      assert.equal(await readFile(file, 'utf8'), 'content', 'the dir is untouched in round 1');

      // Retry with the accepted confirmation and the verified state → deletes.
      const state = await retryState(r1);
      const r2 = await handler(
        { paths: [dir], recursive: true },
        retryCtx({ responses: accept(), state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      const sc = (r2 as { structuredContent?: { ok?: boolean } }).structuredContent;
      assert.equal(sc?.ok, true);
      await assert.rejects(
        readFile(file, 'utf8'),
        { code: 'ENOENT' },
        'dir is deleted on accepted retry',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('move: an overwrite returns input_required and the dest is untouched until an accepted retry', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-era-move-'));
    try {
      const source = join(tmp, 'src.txt');
      const destination = join(tmp, 'dest.txt');
      await writeFile(source, 'source content', 'utf8');
      await writeFile(destination, 'original dest', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);

      // Round 1: the existing dest forces input_required; nothing moves (R6).
      const r1 = await handler({ moves: [{ source, destination }] }, retryCtx());
      assert.ok(
        isInputRequiredResult(r1),
        'round 1 returns input_required, not a silent overwrite',
      );
      assert.equal(
        await readFile(destination, 'utf8'),
        'original dest',
        'the dest is untouched in round 1',
      );

      // Retry with the accepted overwrite and the verified state → moves.
      const state = await retryState(r1);
      const r2 = await handler(
        { moves: [{ source, destination }] },
        retryCtx({ responses: accept(), state }),
      );
      assert.notEqual((r2 as { isError?: boolean }).isError, true);
      assert.equal(
        await readFile(destination, 'utf8'),
        'source content',
        'dest is overwritten on accepted retry',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
