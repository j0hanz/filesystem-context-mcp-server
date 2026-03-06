import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, McpError } from '../../lib/errors.js';
import { decodeOffsetCursor, encodeOffsetCursor } from '../../tools/shared.js';

// ─── encodeOffsetCursor / decodeOffsetCursor ────────────────────────────────

describe('decodeOffsetCursor', () => {
  it('round-trips a valid offset', () => {
    const cursor = encodeOffsetCursor(10);
    assert.equal(decodeOffsetCursor(cursor), 10);
  });

  it('round-trips offset 0', () => {
    const cursor = encodeOffsetCursor(0);
    assert.equal(decodeOffsetCursor(cursor), 0);
  });

  it('throws McpError on non-base64url garbage', () => {
    assert.throws(
      () => decodeOffsetCursor('not-a-valid-cursor'),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.E_INVALID_INPUT
    );
  });

  it('throws McpError when JSON has no offset key', () => {
    const cursor = Buffer.from(JSON.stringify({ wrong: 123 })).toString(
      'base64url'
    );
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.E_INVALID_INPUT
    );
  });

  it('throws McpError when offset is a string', () => {
    const cursor = Buffer.from(JSON.stringify({ offset: '5' })).toString(
      'base64url'
    );
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.E_INVALID_INPUT
    );
  });

  it('throws McpError when offset is negative', () => {
    const cursor = Buffer.from(JSON.stringify({ offset: -1 })).toString(
      'base64url'
    );
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.E_INVALID_INPUT
    );
  });

  it('throws McpError when offset is a float', () => {
    const cursor = Buffer.from(JSON.stringify({ offset: 1.5 })).toString(
      'base64url'
    );
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.E_INVALID_INPUT
    );
  });
});
