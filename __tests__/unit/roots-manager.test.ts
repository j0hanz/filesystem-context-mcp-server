import type { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { RootsManager } from '../../src/server.js';

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
      getClientCapabilities: () => ({}),
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

describe('RootsManager', () => {
  it('coalesces repeated roots change notifications into one update', async () => {
    const manager = new RootsManager({}, { minimumLevel: 'debug' });
    const fakeServer = createFakeServer();
    let updateCalls = 0;

    (manager as unknown as { updateRootsFromClient: () => Promise<void> }).updateRootsFromClient =
      async () => {
        // Only run if not shutting down and not already updating
        const state = (manager as unknown as { state: string }).state;
        if (state === 'shutting_down' || state === 'updating') {
          (manager as unknown as { pendingRootsUpdate: boolean }).pendingRootsUpdate = true;
          return;
        }
        (manager as unknown as { state: string }).state = 'updating';
        updateCalls += 1;
        await Promise.resolve(); // Simulate async work
        (manager as unknown as { state: string }).state = 'idle';
        if ((manager as unknown as { pendingRootsUpdate: boolean }).pendingRootsUpdate) {
          (manager as unknown as { pendingRootsUpdate: boolean }).pendingRootsUpdate = false;
          void (
            manager as unknown as { updateRootsFromClient: () => Promise<void> }
          ).updateRootsFromClient();
        }
      };

    manager.registerHandlers(fakeServer.server);

    await fakeServer.getInitializedHandler()();
    assert.equal(updateCalls, 1);

    const rootsChanged = fakeServer.getRootsChangedHandler();
    rootsChanged();
    rootsChanged();
    rootsChanged();

    await delay(150);
    assert.equal(updateCalls, 2);
  });

  it('cancels pending debounced updates on destroy', async () => {
    const manager = new RootsManager({}, { minimumLevel: 'debug' });
    const fakeServer = createFakeServer();
    let updateCalls = 0;

    (manager as unknown as { updateRootsFromClient: () => Promise<void> }).updateRootsFromClient =
      () => {
        updateCalls += 1;
        (manager as unknown as { state: string }).state = 'idle';
        return Promise.resolve();
      };

    manager.registerHandlers(fakeServer.server);

    await fakeServer.getInitializedHandler()();
    updateCalls = 0;

    fakeServer.getRootsChangedHandler()();
    manager.destroy();

    await delay(150);
    assert.equal(updateCalls, 0);
  });

  it('clears init timer when initialized notification is received', async () => {
    const manager = new RootsManager({}, { minimumLevel: 'debug' });
    const fakeServer = createFakeServer();

    (manager as unknown as { updateRootsFromClient: () => Promise<void> }).updateRootsFromClient =
      () => Promise.resolve();

    manager.registerHandlers(fakeServer.server);

    // initTimer should be set after registerHandlers
    const timerBefore = (manager as unknown as { initTimer: ReturnType<typeof setTimeout> })
      .initTimer;
    assert.ok(timerBefore, 'Expected initTimer to be set after registerHandlers');

    await fakeServer.getInitializedHandler()();

    const timerAfter = (
      manager as unknown as {
        initTimer: ReturnType<typeof setTimeout> | undefined;
      }
    ).initTimer;
    assert.equal(timerAfter, undefined, 'Expected initTimer to be cleared after initialized');

    manager.destroy();
  });

  it('clears init timer on destroy before initialized', () => {
    const manager = new RootsManager({}, { minimumLevel: 'debug' });
    const fakeServer = createFakeServer();

    (manager as unknown as { updateRootsFromClient: () => Promise<void> }).updateRootsFromClient =
      () => Promise.resolve();

    manager.registerHandlers(fakeServer.server);

    const timerBefore = (manager as unknown as { initTimer: ReturnType<typeof setTimeout> })
      .initTimer;
    assert.ok(timerBefore, 'Expected initTimer to be set');

    manager.destroy();

    const timerAfter = (
      manager as unknown as {
        initTimer: ReturnType<typeof setTimeout> | undefined;
      }
    ).initTimer;
    assert.equal(timerAfter, undefined, 'Expected initTimer to be cleared on destroy');
  });

  it('invokes onInitTimeout callback when client never initializes', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const manager = new RootsManager({}, { minimumLevel: 'debug' });
      const fakeServer = createFakeServer();
      let callbackInvoked = false;

      (manager as unknown as { updateRootsFromClient: () => Promise<void> }).updateRootsFromClient =
        () => Promise.resolve();

      manager.registerHandlers(fakeServer.server, () => {
        callbackInvoked = true;
      });

      assert.equal(callbackInvoked, false, 'Callback should not fire before timeout');

      // Advance past the init handshake timeout (30s default)
      mock.timers.tick(30_000);

      assert.equal(callbackInvoked, true, 'Callback should fire after timeout');
      manager.destroy();
    } finally {
      mock.timers.reset();
    }
  });

  it('does not invoke onInitTimeout when initialized arrives first', async () => {
    const manager = new RootsManager({}, { minimumLevel: 'debug' });
    const fakeServer = createFakeServer();
    let callbackInvoked = false;

    (manager as unknown as { updateRootsFromClient: () => Promise<void> }).updateRootsFromClient =
      () => Promise.resolve();

    manager.registerHandlers(fakeServer.server, () => {
      callbackInvoked = true;
    });

    // Simulate initialized arriving
    await fakeServer.getInitializedHandler()();

    // Timer should be cleared
    const timer = (
      manager as unknown as {
        initTimer: ReturnType<typeof setTimeout> | undefined;
      }
    ).initTimer;
    assert.equal(timer, undefined, 'Expected initTimer to be cleared');
    assert.equal(callbackInvoked, false, 'Callback should not be invoked');

    manager.destroy();
  });
});
