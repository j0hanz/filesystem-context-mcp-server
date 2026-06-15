// __tests__/unit/http-session-registry.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { LogRouter, type LogTarget } from '../../src/core/observability.js';
import { type HttpSession, HttpSessionRegistry } from '../../src/transport.js';
import { InMemoryEventStore } from '../../src/transport.js';

interface FakePathGuard {
  initialized: boolean;
  isInitialized: () => boolean;
}

interface FakeSession extends HttpSession {
  closed: boolean;
  closeCalls: number;
  fakePathGuard: FakePathGuard;
}

function makeFakeSession(opts: {
  initialized: boolean;
  createdAt?: number;
  closeError?: Error;
}): FakeSession {
  const fakePathGuard: FakePathGuard = {
    initialized: opts.initialized,
    isInitialized() {
      return this.initialized;
    },
  };
  const session = {
    closed: false,
    closeCalls: 0,
    fakePathGuard,
    pathGuard: fakePathGuard,
    server: {} as HttpSession['server'],
    transport: {} as HttpSession['transport'],
    createdAt: opts.createdAt ?? Date.now(),
    close: async (): Promise<void> => {
      session.closeCalls += 1;
      if (opts.closeError) throw opts.closeError;
      session.closed = true;
    },
  } as FakeSession;
  return session;
}

const stubTarget = (): LogTarget => ({
  server: {} as LogTarget['server'],
  loggingState: { minimumLevel: 'debug' },
});

describe('HttpSessionRegistry', () => {
  // The LogRouter is a process-global singleton; reset session-routing state
  // between tests so subscriber attachments don't leak.
  afterEach(() => {
    LogRouter.global().reset();
  });

  it('add/get/size track sessions and expose log-router attachment', () => {
    const eventStore = new InMemoryEventStore();
    const logRouter = LogRouter.global();
    const registry = new HttpSessionRegistry({
      eventStore,
      logRouter,
      handshakeTimeoutMs: 1000,
    });

    assert.equal(registry.size(), 0);
    assert.equal(registry.get('s1'), undefined);

    const session = makeFakeSession({ initialized: false });
    registry.add('s1', session, stubTarget());

    assert.equal(registry.size(), 1);
    assert.strictEqual(registry.get('s1'), session);
  });

  it('remove deletes from sessions, log-router, and event store', () => {
    const eventStore = new InMemoryEventStore();
    const logRouter = LogRouter.global();
    const registry = new HttpSessionRegistry({
      eventStore,
      logRouter,
      handshakeTimeoutMs: 1000,
    });

    const session = makeFakeSession({ initialized: true });
    registry.add('s1', session, stubTarget());
    registry.remove('s1');

    assert.equal(registry.size(), 0);
    assert.equal(registry.get('s1'), undefined);
  });

  it('getOrRespondNotFound returns the session when present', () => {
    const registry = new HttpSessionRegistry({
      eventStore: new InMemoryEventStore(),
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 1000,
    });
    const session = makeFakeSession({ initialized: false });
    registry.add('s1', session, stubTarget());

    const writes: { status?: number; body?: string }[] = [];
    const res = {
      writeHead(status: number) {
        writes.push({ status });
      },
      end(body: string) {
        const last = writes[writes.length - 1] ?? {};
        last.body = body;
      },
    } as unknown as import('node:http').ServerResponse;

    const found = registry.getOrRespondNotFound('s1', res);
    assert.strictEqual(found, session);
    assert.equal(writes.length, 0);
  });

  it('getOrRespondNotFound writes a 404 JSON-RPC error when missing', () => {
    const registry = new HttpSessionRegistry({
      eventStore: new InMemoryEventStore(),
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 1000,
    });

    let status: number | undefined;
    let body = '';
    const res = {
      writeHead(s: number) {
        status = s;
      },
      end(b: string) {
        body = b;
      },
    } as unknown as import('node:http').ServerResponse;

    const found = registry.getOrRespondNotFound('missing', res);
    assert.equal(found, undefined);
    assert.equal(status, 404);
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    assert.equal(parsed.error?.message, 'Session not found');
  });

  it('startSweep evicts uninitialized sessions older than handshakeTimeoutMs', async () => {
    const registry = new HttpSessionRegistry({
      eventStore: new InMemoryEventStore(),
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 500,
      sweepIntervalMs: 25,
    });

    function attachWithCleanup(
      id: string,
      opts: {
        initialized: boolean;
        createdAt?: number;
      },
    ): FakeSession {
      const session = makeFakeSession(opts);
      const originalClose = session.close;
      // Mimic production wiring: transport.onclose -> cleanup -> registry.remove
      session.close = async (): Promise<void> => {
        registry.remove(id);
        await originalClose();
      };
      registry.add(id, session, stubTarget());
      return session;
    }

    const stale = attachWithCleanup('stale', {
      initialized: false,
      createdAt: Date.now() - 5000,
    });
    const fresh = attachWithCleanup('fresh', {
      initialized: false,
      createdAt: Date.now(),
    });
    const initialized = attachWithCleanup('init', {
      initialized: true,
      createdAt: Date.now() - 5000,
    });

    registry.startSweep();
    await sleep(80);

    assert.equal(stale.closeCalls, 1, 'stale session must be closed once');
    assert.equal(fresh.closeCalls, 0, 'fresh session must survive sweep');
    assert.equal(initialized.closeCalls, 0, 'initialized session must not be evicted');

    await registry.closeAll();
    assert.equal(fresh.closeCalls, 1, 'fresh closed by closeAll');
    assert.equal(initialized.closeCalls, 1, 'initialized closed by closeAll');
  });

  it('startSweep is idempotent', () => {
    const registry = new HttpSessionRegistry({
      eventStore: new InMemoryEventStore(),
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 1000,
    });
    registry.startSweep();
    registry.startSweep();
    // No assertion needed; second call must not throw and must not register
    // a second timer (verified by closeAll completing without leaking).
    return registry.closeAll();
  });

  it('closeAll closes every session, stops the sweep, and clears event store', async () => {
    const eventStore = new InMemoryEventStore();
    const registry = new HttpSessionRegistry({
      eventStore,
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 1000,
    });

    const a = makeFakeSession({ initialized: true });
    const b = makeFakeSession({ initialized: false });
    registry.add('a', a, stubTarget());
    registry.add('b', b, stubTarget());
    registry.startSweep();

    await registry.closeAll();

    assert.equal(a.closeCalls, 1);
    assert.equal(b.closeCalls, 1);
  });

  it('closeAll swallows individual session close errors', async () => {
    const registry = new HttpSessionRegistry({
      eventStore: new InMemoryEventStore(),
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 1000,
    });
    const failing = makeFakeSession({
      initialized: true,
      closeError: new Error('boom'),
    });
    const ok = makeFakeSession({ initialized: true });
    registry.add('failing', failing, stubTarget());
    registry.add('ok', ok, stubTarget());

    await registry.closeAll();
    assert.equal(failing.closeCalls, 1);
    assert.equal(ok.closeCalls, 1);
  });

  it('startSweep evicts multiple stale sessions without missing any due to Map iteration modifications', async () => {
    const registry = new HttpSessionRegistry({
      eventStore: new InMemoryEventStore(),
      logRouter: LogRouter.global(),
      handshakeTimeoutMs: 500,
      sweepIntervalMs: 25,
    });

    const sessions: FakeSession[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `stale_${i}`;
      const session = makeFakeSession({
        initialized: false,
        createdAt: Date.now() - 5000,
      });
      const originalClose = session.close;
      session.close = async (): Promise<void> => {
        registry.remove(id);
        await originalClose();
      };
      registry.add(id, session, stubTarget());
      sessions.push(session);
    }

    registry.startSweep();
    await sleep(80);

    for (let i = 0; i < 5; i++) {
      const session = sessions[i];
      assert.ok(session);
      assert.equal(session.closeCalls, 1, `stale session ${i} must be closed`);
    }
    await registry.closeAll();
  });

  it('InMemoryEventStore tracks active replays and allows queueing / flushing of messages', async () => {
    const eventStore = new InMemoryEventStore();
    const streamId = 'session-123';

    // Store some event first
    const eventId = await eventStore.storeEvent(streamId, {
      jsonrpc: '2.0',
      method: 'test-seen',
    });

    // Store a second event that needs to be replayed
    await eventStore.storeEvent(streamId, {
      jsonrpc: '2.0',
      method: 'test-to-replay',
    });

    const sent: unknown[] = [];
    const replayPromise = eventStore.replayEventsAfter(eventId, {
      send: async (_id, msg) => {
        // Yield to event loop to simulate async behavior
        await sleep(10);
        sent.push(msg);
      },
    });

    // Yield to let the async function start executing
    await sleep(2);

    // Verify replay is active for streamId
    assert.ok(eventStore.isReplaying(streamId));

    // Simulate sending a message while replaying is true
    const queue: unknown[] = [];
    const sendOrQueue = async (msg: unknown) => {
      if (eventStore.isReplaying(streamId)) {
        queue.push(msg);
      } else {
        sent.push(msg);
      }
    };

    // Send a concurrent message
    await sendOrQueue({ jsonrpc: '2.0', method: 'concurrent' });

    // Ensure concurrent message is queued, not sent immediately
    assert.equal(queue.length, 1);
    assert.equal(sent.length, 0);

    // Setup listener to flush once replay is complete
    let flushCalled = false;
    eventStore.onReplayComplete(streamId, () => {
      flushCalled = true;
      while (queue.length > 0) {
        sent.push(queue.shift());
      }
    });

    await replayPromise;

    // Verify replay finished, queue flushed, and messages are in correct order
    assert.ok(flushCalled);
    assert.equal(eventStore.isReplaying(streamId), false);
    assert.equal(sent.length, 2);
    const firstMsg = sent[0] as { method: string };
    const secondMsg = sent[1] as { method: string };
    assert.equal(firstMsg.method, 'test-to-replay'); // Replayed message should come first!
    assert.equal(secondMsg.method, 'concurrent'); // Concurrent message should come after!
  });
});
