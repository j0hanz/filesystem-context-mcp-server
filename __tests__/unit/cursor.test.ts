import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  closePage,
  decodeOffsetCursor,
  encodeOffsetCursor,
  openPage,
} from '../../src/core/cursor.js';
import { ErrorCode, FsError } from '../../src/core/errors.js';

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

  it('throws FsError on non-base64url garbage', () => {
    assert.throws(
      () => decodeOffsetCursor('not-a-valid-cursor'),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws FsError when JSON has no offset key', () => {
    const cursor = encodeCursor({ wrong: 123 });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws FsError when offset is a string', () => {
    const cursor = encodeCursor({ offset: '5' });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws FsError when offset is negative', () => {
    const cursor = encodeCursor({ offset: -1 });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });

  it('throws FsError when offset is a float', () => {
    const cursor = encodeCursor({ offset: 1.5 });
    assert.throws(
      () => decodeOffsetCursor(cursor),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });
});

// ─── openPage / closePage ───────────────────────────────────────────────────

describe('openPage', () => {
  it('starts at offset 0 with no cursor', () => {
    assert.deepEqual(openPage({ cursor: undefined, pageSize: 100, max: 10000 }), {
      offset: 0,
      fetchMax: 100,
    });
  });

  it('fetches through the end of the requested page', () => {
    assert.deepEqual(openPage({ cursor: encodeOffsetCursor(250), pageSize: 100, max: 10000 }), {
      offset: 250,
      fetchMax: 350,
    });
  });

  it('never fetches past the query cap', () => {
    assert.deepEqual(openPage({ cursor: encodeOffsetCursor(9950), pageSize: 100, max: 10000 }), {
      offset: 9950,
      fetchMax: 10000,
    });
  });

  it('rejects a cursor it did not issue', () => {
    assert.throws(
      () => openPage({ cursor: 'not-a-valid-cursor', pageSize: 100, max: 10000 }),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });
});

describe('closePage', () => {
  it('points at the next page when the scan was truncated', () => {
    assert.equal(
      closePage({ truncated: true, offset: 250, pageCount: 100 }),
      encodeOffsetCursor(350),
    );
  });

  it('issues no cursor when the scan ran to completion', () => {
    assert.equal(closePage({ truncated: false, offset: 250, pageCount: 100 }), undefined);
  });

  it('issues no cursor when a truncated page yielded nothing', () => {
    // Otherwise the caller loops forever on a cursor pointing at its own offset.
    assert.equal(closePage({ truncated: true, offset: 250, pageCount: 0 }), undefined);
  });
});
