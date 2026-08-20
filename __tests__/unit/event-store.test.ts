// __tests__/unit/event-store.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from '../../src/transport.js';

function msg(id: number): { jsonrpc: '2.0'; method: string; params: { id: number } } {
  return { jsonrpc: '2.0', method: 'notifications/progress', params: { id } };
}

describe('InMemoryEventStore', () => {
  it('resolves the stream id for a stored event', async () => {
    const store = new InMemoryEventStore();
    const eventId = await store.storeEvent('stream-a', msg(1));
    assert.equal(await store.getStreamIdForEventId(eventId), 'stream-a');
  });

  it('returns undefined for an unknown event id', async () => {
    const store = new InMemoryEventStore();
    assert.equal(await store.getStreamIdForEventId('nonexistent'), undefined);
  });

  it('replays only events after the given event id, in order', async () => {
    const store = new InMemoryEventStore();
    const id1 = await store.storeEvent('stream-a', msg(1));
    await store.storeEvent('stream-a', msg(2));
    await store.storeEvent('stream-a', msg(3));

    const replayed: unknown[] = [];
    const streamId = await store.replayEventsAfter(id1, {
      send: (_eventId, message) => {
        replayed.push(message);
        return Promise.resolve();
      },
    });

    assert.equal(streamId, 'stream-a');
    assert.deepEqual(replayed, [msg(2), msg(3)]);
  });

  it('rejects replay for an unknown event id', async () => {
    const store = new InMemoryEventStore();
    await assert.rejects(store.replayEventsAfter('nonexistent', { send: () => Promise.resolve() }));
  });

  it('evicts the oldest event once a stream exceeds the cap', async () => {
    const store = new InMemoryEventStore();
    const MAX_EVENTS_PER_STREAM = 1000;
    const firstEventId = await store.storeEvent('stream-a', msg(0));

    for (let i = 1; i <= MAX_EVENTS_PER_STREAM; i++) {
      await store.storeEvent('stream-a', msg(i));
    }

    // The first event should have been evicted once the cap was exceeded.
    assert.equal(await store.getStreamIdForEventId(firstEventId), undefined);
  });

  it('clear() wipes every stream', async () => {
    const store = new InMemoryEventStore();
    const idA = await store.storeEvent('stream-a', msg(1));
    const idB = await store.storeEvent('stream-b', msg(2));
    store.clear();
    assert.equal(await store.getStreamIdForEventId(idA), undefined);
    assert.equal(await store.getStreamIdForEventId(idB), undefined);
  });
});
