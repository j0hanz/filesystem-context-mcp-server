import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFirstPage, readNextPage } from '../src/core/cursor.js';
import { ErrorCode, isFsError } from '../src/core/errors.js';
import { PageSnapshotStore } from '../src/core/page-store.js';

function assertInvalidCursor(error: unknown): boolean {
  assert(isFsError(error));
  assert.strictEqual(error.code, ErrorCode.INVALID_INPUT);
  assert.match(error.message, /Request the first page without a cursor/);
  return true;
}

describe('PageSnapshotStore', () => {
  it('stores pages, rejects old and malformed cursors, and checks query keys', () => {
    const store = new PageSnapshotStore();
    const first = createFirstPage({
      store,
      queryKey: '{"method":"list","path":"one"}',
      items: ['a', 'b'],
      metadata: { total: 2 },
      pageSize: 1,
    });

    assert.deepStrictEqual(first.page, ['a']);
    const cursor = first.nextCursor;
    assert.ok(cursor);
    assert.throws(
      () =>
        readNextPage({
          store,
          queryKey: '{"method":"list","path":"two"}',
          cursor,
          pageSize: 1,
        }),
      assertInvalidCursor,
    );
    assert.throws(
      () =>
        readNextPage({
          store,
          queryKey: '{"method":"list","path":"one"}',
          cursor: Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url'),
          pageSize: 1,
        }),
      assertInvalidCursor,
    );
    assert.throws(
      () =>
        readNextPage({
          store,
          queryKey: '{"method":"list","path":"one"}',
          cursor: 'not-a-cursor',
          pageSize: 1,
        }),
      assertInvalidCursor,
    );
    assert.throws(
      () =>
        readNextPage({
          store,
          queryKey: '{"method":"list","path":"one"}',
          cursor: Buffer.from(JSON.stringify({ snapshotId: 'evicted', offset: 0 })).toString(
            'base64url',
          ),
          pageSize: 1,
        }),
      assertInvalidCursor,
    );
    const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    assert.throws(
      () =>
        readNextPage({
          store,
          queryKey: '{"method":"list","path":"one"}',
          cursor: Buffer.from(JSON.stringify({ ...decodedCursor, offset: 99 })).toString(
            'base64url',
          ),
          pageSize: 1,
        }),
      assertInvalidCursor,
    );

    const second = readNextPage({
      store,
      queryKey: '{"method":"list","path":"one"}',
      cursor,
      pageSize: 1,
    });
    assert.deepStrictEqual(second.page, ['b']);
    assert.deepStrictEqual(second.metadata, { total: 2 });
    assert.strictEqual(second.nextCursor, undefined);
  });

  it('evicts least-recently-read snapshots and expires them', () => {
    let now = 0;
    const store = new PageSnapshotStore({ maxSnapshots: 2, ttlMs: 10, now: () => now });
    const queryKey = '{"method":"list"}';
    const first = store.create({ queryKey, items: ['a'] });
    const second = store.create({ queryKey, items: ['b'] });
    store.read(first, queryKey);
    const third = store.create({ queryKey, items: ['c'] });

    assert.throws(() => store.read(second, queryKey), assertInvalidCursor);
    assert.deepStrictEqual(store.read(first, queryKey).items, ['a']);
    assert.deepStrictEqual(store.read(third, queryKey).items, ['c']);

    now = 10;
    assert.throws(() => store.read(first, queryKey), assertInvalidCursor);
  });

  it('does not create a snapshot when the complete result fits one page', () => {
    const store = new PageSnapshotStore({ maxSnapshots: 0 });
    const result = createFirstPage({
      store,
      queryKey: '{"method":"list"}',
      items: ['complete'],
      metadata: undefined,
      pageSize: 1,
    });

    assert.deepStrictEqual(result.page, ['complete']);
    assert.strictEqual(result.nextCursor, undefined);
  });
});
