import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, McpError } from '../../src/core/errors.js';
import { decodeOffsetCursor, encodeOffsetCursor } from '../../src/tools/_helpers.js';

// ─── Helper functions ───────────────────────────────────────────────────────

/**
 * Encode an object to a base64url-encoded JSON string.
 */
function encodeCursor(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

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
      (err: unknown) => err instanceof McpError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws McpError when JSON has no offset key', () => {
    const cursor = encodeCursor({ wrong: 123 });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof McpError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws McpError when offset is a string', () => {
    const cursor = encodeCursor({ offset: '5' });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof McpError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws McpError when offset is negative', () => {
    const cursor = encodeCursor({ offset: -1 });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof McpError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws McpError when offset is a float', () => {
    const cursor = encodeCursor({ offset: 1.5 });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof McpError && err.code === ErrorCode.INVALID_INPUT,
    );
  });
});
