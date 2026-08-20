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
  it('starts at offset 0 and fetches the full capped set', () => {
    assert.deepEqual(openPage({ cursor: undefined, max: 10000 }), {
      offset: 0,
      fetchMax: 10000,
    });
  });

  it('fetches the full capped set on every page', () => {
    // Every page re-runs the query and sorts before slicing, so it must sort the
    // same universe every time: fetchMax is always `max`, not offset+pageSize.
    // Capping at offset+pageSize would slice a different unsorted prefix each
    // page and overlap/skip matches.
    assert.deepEqual(openPage({ cursor: encodeOffsetCursor(250), max: 10000 }), {
      offset: 250,
      fetchMax: 10000,
    });
  });

  it('never fetches past the query cap', () => {
    assert.deepEqual(openPage({ cursor: encodeOffsetCursor(9950), max: 10000 }), {
      offset: 9950,
      fetchMax: 10000,
    });
  });

  it('rejects a cursor it did not issue', () => {
    assert.throws(
      () => openPage({ cursor: 'not-a-valid-cursor', max: 10000 }),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.INVALID_INPUT,
    );
  });
});

describe('closePage', () => {
  it('points at the next page when more results remain', () => {
    assert.equal(closePage({ total: 500, offset: 250, pageCount: 100 }), encodeOffsetCursor(350));
  });

  it('issues no cursor when the page reached the end of the set', () => {
    assert.equal(closePage({ total: 350, offset: 250, pageCount: 100 }), undefined);
  });

  it('issues no cursor when a page yielded nothing', () => {
    // Otherwise the caller loops forever on a cursor pointing at its own offset.
    assert.equal(closePage({ total: 250, offset: 250, pageCount: 0 }), undefined);
  });
});
