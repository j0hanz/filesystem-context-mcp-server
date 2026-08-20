import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { PathGuard } from '../../src/core/path.js';
import { McpRootsSynchronizer } from '../../src/core/registrar.js';

function createFakeServer(): {
  server: McpServer;
  getInitializedHandler: () => () => Promise<void>;
  getRootsChangedHandler: () => (() => Promise<void>) | (() => void);
} {
  let initializedHandler: (() => Promise<void>) | undefined;
  let rootsChangedHandler: (() => Promise<void>) | (() => void) | undefined;

  const server = {
    server: {
      setNotificationHandler: (method: string, handler: (() => Promise<void>) | (() => void)) => {
        if (method === 'notifications/initialized') {
          initializedHandler = handler as () => Promise<void>;
        }
        if (method === 'notifications/roots/list_changed') {
          rootsChangedHandler = handler;
        }
      },
      getClientCapabilities: () => ({ roots: true }),
      // Resolves with no roots; rootDirectories ends up [].
      listRoots: () => Promise.resolve({ roots: [] }),
    },
  } as unknown as McpServer;

  return {
    server,
    getInitializedHandler(): () => Promise<void> {
      assert.ok(initializedHandler, 'Expected initialized handler');
      return initializedHandler;
    },
    getRootsChangedHandler(): (() => Promise<void>) | (() => void) {
      assert.ok(rootsChangedHandler, 'Expected roots changed handler');
      return rootsChangedHandler;
    },
  };
}

describe('McpRootsSynchronizer failure recovery', () => {
  it('still applies a later roots change after setRoots rejects once', async () => {
    let setRootsCalls = 0;
    let rejectNext = true;
    const fakePathGuard = {
      isServerContext: true,
      getAllowedDirectories: () => [],
      async setRoots(_roots: readonly string[]): Promise<void> {
        setRootsCalls += 1;
        if (rejectNext) {
          rejectNext = false;
          throw new Error('boom');
        }
      },
    } as unknown as PathGuard;

    const manager = new McpRootsSynchronizer(fakePathGuard, true);
    const fakeServer = createFakeServer();
    manager.registerHandlers(fakeServer.server);

    // The initialized notification triggers the first updateRootsFromClient,
    // whose setRoots rejects. With the finally guard, state must reach idle.
    await fakeServer.getInitializedHandler()();
    assert.equal(setRootsCalls, 1, 'first setRoots must have been attempted');
    assert.equal(manager.isInitialized(), true, 'state must recover to idle');

    // A subsequent roots/list_changed must still drive a setRoots call.
    fakeServer.getRootsChangedHandler()();
    await delay(150);
    assert.ok(setRootsCalls >= 2, 'second setRoots must run after the first failed');

    manager.destroy();
  });

  it('does not re-arm a queued roots update when destroy() lands during setRoots await', async () => {
    let setRootsCalls = 0;
    let resolveSetRoots!: () => void;
    const setRootsGate = new Promise<void>((resolve) => {
      resolveSetRoots = resolve;
    });
    const fakePathGuard = {
      isServerContext: true,
      getAllowedDirectories: () => [],
      async setRoots(): Promise<void> {
        setRootsCalls += 1;
        // Block the in-flight updateRootsFromClient so destroy() can land mid-await.
        await setRootsGate;
      },
    } as unknown as PathGuard;

    const manager = new McpRootsSynchronizer(fakePathGuard, true);
    const fakeServer = createFakeServer();
    manager.registerHandlers(fakeServer.server);

    // Start the first updateRootsFromClient (via the initialized handler) but
    // do not await it: it parks at the setRoots gate with state === 'updating'.
    const initPromise = fakeServer.getInitializedHandler()();
    // Let the event loop settle so state reaches 'updating' before we proceed.
    await delay(0);

    // Queue a roots/list_changed: the debounced re-entry finds state 'updating'
    // and sets pendingRootsUpdate = true without calling setRoots again.
    fakeServer.getRootsChangedHandler()();
    await delay(120); // ROOTS_DEBOUNCE_MS is 100ms

    // Destroy mid-await — the finally block must observe 'shutting_down' and
    // skip both the idle transition and the pendingRootsUpdate re-arm.
    manager.destroy();

    // Release the gate; the finally guard must NOT re-arm the queued update.
    resolveSetRoots();
    await initPromise;
    await delay(150); // give any stray re-arm a chance to fire (it must not)

    assert.equal(setRootsCalls, 1, 'setRoots must not be re-invoked after destroy()');
    assert.equal(manager.isInitialized(), false, 'state must not recover to idle after destroy()');
  });
});
