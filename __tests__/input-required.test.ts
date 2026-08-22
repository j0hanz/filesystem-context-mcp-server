import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import {
  buildInputRequired,
  confirmInput,
  pendingRoundTrip,
  readAcceptedConfirm,
  requestStateCodec,
} from '../src/tools/input-required.js';

describe('input_required multi-round-trip infrastructure', () => {
  it('1. requestStateCodec mint/verify round-trip', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a', '/b'] });
    const decoded = await requestStateCodec.verify(wire);
    assert.strictEqual(decoded.op, 'delete');
    assert.deepStrictEqual(decoded.paths, ['/a', '/b']);
  });

  it('2. requestStateCodec.verify rejects a tampered token', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a'] });
    assert.ok(wire.length > 0);
    const tampered = wire.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    await assert.rejects(async () => {
      await requestStateCodec.verify(tampered);
    });
  });

  it('3. pendingRoundTrip with no requestState mints a fresh input_required', async () => {
    const result = await pendingRoundTrip({
      op: 'delete',
      pending: ['/a'],
      requestState: undefined,
      buildInputs: (paths) => paths.map((p, idx) => confirmInput(`confirm_${idx}`, `Delete ${p}?`)),
    });
    assert.ok(result !== undefined);
    assert.strictEqual(isInputRequiredResult(result), true);
  });

  it('4. pendingRoundTrip same-op + same paths returns undefined (proceed)', async () => {
    const wire = await requestStateCodec.mint({ op: 'move', paths: ['/x'] });
    const decoded = await requestStateCodec.verify(wire);
    const result = await pendingRoundTrip({
      op: 'move',
      pending: ['/x'],
      requestState: () => decoded,
      buildInputs: (paths) => paths.map((p, idx) => confirmInput(`confirm_${idx}`, `Move ${p}?`)),
    });
    assert.strictEqual(result, undefined);
  });

  it('5. pendingRoundTrip same-op + different paths throws FsError(INVALID_INPUT) (R9)', async () => {
    const wire = await requestStateCodec.mint({ op: 'move', paths: ['/x'] });
    const decoded = await requestStateCodec.verify(wire);
    await assert.rejects(
      async () => {
        await pendingRoundTrip({
          op: 'move',
          pending: ['/y'],
          requestState: () => decoded,
          buildInputs: (paths) =>
            paths.map((p, idx) => confirmInput(`confirm_${idx}`, `Move ${p}?`)),
        });
      },
      (e: unknown) => isFsError(e) && e.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('6. pendingRoundTrip different-op mints fresh input_required', async () => {
    const wire = await requestStateCodec.mint({ op: 'grant', paths: ['/x'] });
    const decoded = await requestStateCodec.verify(wire);
    const result = await pendingRoundTrip({
      op: 'delete',
      pending: ['/x'],
      requestState: () => decoded,
      buildInputs: (paths) => paths.map((p, idx) => confirmInput(`confirm_${idx}`, `Delete ${p}?`)),
    });
    assert.ok(result !== undefined);
    assert.strictEqual(isInputRequiredResult(result), true);
  });

  it('7. buildInputRequired shape', async () => {
    const r = await buildInputRequired({ op: 'delete', paths: ['/a'] }, [
      confirmInput('confirm_0', 'Delete /a?'),
    ]);
    assert.strictEqual(isInputRequiredResult(r), true);
    assert.ok(r.inputRequests['confirm_0'] !== undefined);
    assert.strictEqual(typeof r.requestState, 'string');
    assert.ok(typeof r.requestState === 'string' && r.requestState.length > 0);
  });

  it('8. readAcceptedConfirm accept-true -> true', () => {
    const accepted = readAcceptedConfirm(
      { confirm_0: { action: 'accept', content: { confirm: true } } },
      'confirm_0',
    );
    assert.strictEqual(accepted, true);
  });

  it('9. readAcceptedConfirm decline / cancel / missing-key / accept-without-confirm -> false', () => {
    assert.strictEqual(
      readAcceptedConfirm({ confirm_0: { action: 'decline' } }, 'confirm_0'),
      false,
    );
    assert.strictEqual(
      readAcceptedConfirm({ confirm_0: { action: 'cancel' } }, 'confirm_0'),
      false,
    );
    assert.strictEqual(
      readAcceptedConfirm(
        { other_key: { action: 'accept', content: { confirm: true } } },
        'confirm_0',
      ),
      false,
    );
    assert.strictEqual(
      readAcceptedConfirm({ confirm_0: { action: 'accept', content: {} } }, 'confirm_0'),
      false,
    );
  });
});
