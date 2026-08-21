/**
 * Step 1 infrastructure check: the requestState codec round-trips and rejects
 * tampering, `buildInputRequired` produces a well-formed `input_required` result
 * with sorted-path state, and `readAcceptedConfirm` accepts only an explicit
 * accepted `confirm: true`. This is the one runnable check for the security
 * path (integrity-protected state) before the destructive flows consume it.
 */
import type { ServerContext } from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildInputRequired,
  confirmInput,
  type PendingInput,
  type PendingOp,
  type PendingState,
  readAcceptedConfirm,
  requestStateCodec,
} from '../../src/tools/input-required.js';

// The codec is created without a `bind` callback, so `verify` ignores its ctx.
const NO_CTX = undefined as unknown as ServerContext;

describe('input_required infrastructure', () => {
  describe('requestStateCodec', () => {
    it('mint→verify round-trips the pending state verbatim', async () => {
      const pending: PendingState = { op: 'delete', paths: ['/b', '/a'] };
      const state = await requestStateCodec.mint(pending);
      assert.equal(typeof state, 'string');
      const decoded = await requestStateCodec.verify(state, NO_CTX);
      assert.deepEqual(decoded, { op: 'delete', paths: ['/b', '/a'] });
    });

    it('rejects a tampered requestState', async () => {
      const state = await requestStateCodec.mint({ op: 'move', paths: ['/x'] });
      // Tamper the FIRST char, not the last: a base64url segment's last char
      // may carry padding bits, so a single-bit flip there can decode to the
      // same bytes and leave the HMAC intact (flaky pass). The first char maps
      // all 6 bits into byte 0 — no padding — so any flip is a real change and
      // the HMAC mismatch is guaranteed.
      const first = state[0];
      const tampered = (first === 'A' ? 'B' : 'A') + state.slice(1);
      await assert.rejects(() => requestStateCodec.verify(tampered, NO_CTX));
    });
  });

  describe('buildInputRequired', () => {
    it('builds an input_required result with one request per item and sorted-path state', async () => {
      const op: PendingOp = 'delete';
      const inputs: PendingInput[] = [
        confirmInput('item_0', 'Delete /a?'),
        confirmInput('item_1', 'Delete /b?'),
      ];
      const result = await buildInputRequired({ op, paths: ['/b', '/a'] }, inputs);
      assert.ok(isInputRequiredResult(result));
      assert.equal(result.resultType, 'input_required');
      assert.deepEqual(Object.keys(result.inputRequests ?? {}).sort(), ['item_0', 'item_1']);
      assert.ok(result.requestState, 'expected a minted requestState');
      const decoded = await requestStateCodec.verify(result.requestState, NO_CTX);
      assert.deepEqual(decoded, { op: 'delete', paths: ['/a', '/b'] });
    });
  });

  describe('readAcceptedConfirm', () => {
    it('returns true only for an accepted confirm=true', () => {
      const responses = { item_0: { action: 'accept', content: { confirm: true } } };
      assert.equal(readAcceptedConfirm(responses, 'item_0'), true);
    });

    it('returns false for accept with confirm false', () => {
      const responses = { item_0: { action: 'accept', content: { confirm: false } } };
      assert.equal(readAcceptedConfirm(responses, 'item_0'), false);
    });

    it('returns false for decline', () => {
      assert.equal(readAcceptedConfirm({ item_0: { action: 'decline' } }, 'item_0'), false);
    });

    it('returns false for cancel', () => {
      assert.equal(readAcceptedConfirm({ item_0: { action: 'cancel' } }, 'item_0'), false);
    });

    it('returns false for a missing key', () => {
      assert.equal(readAcceptedConfirm({}, 'item_0'), false);
      assert.equal(readAcceptedConfirm(undefined, 'item_0'), false);
    });
  });
});
