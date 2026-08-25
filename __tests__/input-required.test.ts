import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import {
  assertFleetRequestStateKey,
  buildInputRequired,
  choiceInput,
  confirmInput,
  multiSelectInput,
  pendingRoundTrip,
  readAcceptedChoice,
  readAcceptedConfirm,
  readAcceptedMultiChoice,
  requestStateCodec,
} from '../src/core/input-required.js';

describe('input_required multi-round-trip infrastructure', () => {
  it('1. requestStateCodec mint/verify round-trip', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a', '/b'] });
    const decoded = await requestStateCodec.verify(wire);
    assert.strictEqual(decoded.op, 'delete');
    assert.deepStrictEqual(decoded.paths, ['/a', '/b']);
  });

  it('2. requestStateCodec.verify rejects a tampered token', async () => {
    const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a'] });
    assert.ok(wire.length > 10);
    const tampered = wire.slice(0, 10) + (wire[10] === 'X' ? 'Y' : 'X') + wire.slice(11);
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

  const overwriteSkipChoices = [
    { value: 'overwrite', title: 'Overwrite' },
    { value: 'skip', title: 'Skip' },
  ];

  it('10. buildInputRequired with choiceInput returns InputRequiredResult with requestState', async () => {
    const r = await buildInputRequired({ op: 'copy', paths: ['/dst'] }, [
      choiceInput(
        'confirm_0',
        'Destination "/dst" exists. Overwrite or skip?',
        overwriteSkipChoices,
      ),
    ]);
    assert.strictEqual(isInputRequiredResult(r), true);
    assert.ok(r.inputRequests['confirm_0'] !== undefined);
    assert.strictEqual(typeof r.requestState, 'string');
    assert.ok(typeof r.requestState === 'string' && r.requestState.length > 0);
  });

  it('11. readAcceptedChoice accept-skip -> "skip"', () => {
    assert.strictEqual(
      readAcceptedChoice(
        { confirm_0: { action: 'accept', content: { choice: 'skip' } } },
        'confirm_0',
      ),
      'skip',
    );
  });

  it('12. readAcceptedChoice accept-overwrite -> "overwrite"', () => {
    assert.strictEqual(
      readAcceptedChoice(
        { confirm_0: { action: 'accept', content: { choice: 'overwrite' } } },
        'confirm_0',
      ),
      'overwrite',
    );
  });

  it('13. readAcceptedChoice decline -> undefined', () => {
    assert.strictEqual(
      readAcceptedChoice({ confirm_0: { action: 'decline' } }, 'confirm_0'),
      undefined,
    );
  });

  it('14. readAcceptedChoice accept-without-choice -> undefined', () => {
    assert.strictEqual(
      readAcceptedChoice({ confirm_0: { action: 'accept', content: {} } }, 'confirm_0'),
      undefined,
    );
  });

  it('15. readAcceptedChoice missing-key -> undefined', () => {
    assert.strictEqual(
      readAcceptedChoice({ other: { action: 'accept', content: { choice: 'skip' } } }, 'confirm_0'),
      undefined,
    );
  });

  const grantChoices = [
    { value: '/dir/a', title: '/dir/a' },
    { value: '/dir/b', title: '/dir/b' },
  ];

  it('16. buildInputRequired with multiSelectInput returns InputRequiredResult', async () => {
    const r = await buildInputRequired({ op: 'grant', paths: ['/dir/a', '/dir/b'] }, [
      multiSelectInput('grant', 'Grant access to these directories?', grantChoices),
    ]);
    assert.strictEqual(isInputRequiredResult(r), true);
    assert.ok(r.inputRequests['grant'] !== undefined);
    assert.strictEqual(typeof r.requestState, 'string');
  });

  it('17. readAcceptedMultiChoice accept-array -> array', () => {
    assert.deepStrictEqual(
      readAcceptedMultiChoice(
        { grant: { action: 'accept', content: { choice: ['/dir/a'] } } },
        'grant',
      ),
      ['/dir/a'],
    );
  });

  it('18. readAcceptedMultiChoice decline -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice({ grant: { action: 'decline' } }, 'grant'),
      undefined,
    );
  });

  it('19. readAcceptedMultiChoice accept-with-non-array-choice -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice(
        { grant: { action: 'accept', content: { choice: '/dir/a' } } },
        'grant',
      ),
      undefined,
    );
  });

  it('20. readAcceptedMultiChoice accept-with-empty-content -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice({ grant: { action: 'accept', content: {} } }, 'grant'),
      undefined,
    );
  });

  it('21. readAcceptedMultiChoice missing-key -> undefined', () => {
    assert.strictEqual(
      readAcceptedMultiChoice(
        { other: { action: 'accept', content: { choice: ['/dir/a'] } } },
        'grant',
      ),
      undefined,
    );
  });
});

describe('assertFleetRequestStateKey (boot-time HTTP guard)', () => {
  const envKeys = ['API_KEY', 'FILESYSTEM_MCP_REQUEST_STATE_KEY'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it('throws when API_KEY set and request state key is missing', () => {
    process.env['API_KEY'] = 'sekret';
    delete process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    assert.throws(() => assertFleetRequestStateKey(), /FILESYSTEM_MCP_REQUEST_STATE_KEY/);
  });

  it('throws when API_KEY set and request state key is <32 bytes', () => {
    process.env['API_KEY'] = 'sekret';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = 'short';
    assert.throws(() => assertFleetRequestStateKey(), />=32 bytes/);
  });

  it('is a no-op when API_KEY is unset (stdio / public HTTP)', () => {
    delete process.env['API_KEY'];
    delete process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    assert.doesNotThrow(() => assertFleetRequestStateKey());
  });

  it('is a no-op when API_KEY set and request state key is >=32 bytes', () => {
    process.env['API_KEY'] = 'sekret';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = 'a'.repeat(32);
    assert.doesNotThrow(() => assertFleetRequestStateKey());
  });
});
