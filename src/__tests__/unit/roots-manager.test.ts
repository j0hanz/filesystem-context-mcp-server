import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { RootsManager } from '../../server/roots-manager.js';

function createFakeServer(): {
  server: McpServer;
  getInitializedHandler: () => () => Promise<void>;
  getRootsChangedHandler: () => () => void;
} {
  let initializedHandler: (() => Promise<void>) | undefined;
  let rootsChangedHandler: (() => void) | undefined;

  const server = {
    server: {
      setNotificationHandler: (
        schema: unknown,
        handler: (() => Promise<void>) | (() => void)
      ) => {
        if (schema === InitializedNotificationSchema) {
          initializedHandler = handler as () => Promise<void>;
        }
        if (schema === RootsListChangedNotificationSchema) {
          rootsChangedHandler = handler as () => void;
        }
      },
    },
  } as unknown as McpServer;

  return {
    server,
    getInitializedHandler(): () => Promise<void> {
      assert.ok(initializedHandler, 'Expected initialized handler');
      return initializedHandler;
    },
    getRootsChangedHandler(): () => void {
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

    (
      manager as unknown as { updateRootsFromClient: () => Promise<void> }
    ).updateRootsFromClient = () => {
      updateCalls += 1;
      return Promise.resolve();
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

    (
      manager as unknown as { updateRootsFromClient: () => Promise<void> }
    ).updateRootsFromClient = () => {
      updateCalls += 1;
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

    (
      manager as unknown as { updateRootsFromClient: () => Promise<void> }
    ).updateRootsFromClient = () => Promise.resolve();

    manager.registerHandlers(fakeServer.server);

    // initTimer should be set after registerHandlers
    const timerBefore = (
      manager as unknown as { initTimer: ReturnType<typeof setTimeout> }
    ).initTimer;
    assert.ok(
      timerBefore,
      'Expected initTimer to be set after registerHandlers'
    );

    await fakeServer.getInitializedHandler()();

    const timerAfter = (
      manager as unknown as {
        initTimer: ReturnType<typeof setTimeout> | undefined;
      }
    ).initTimer;
    assert.equal(
      timerAfter,
      undefined,
      'Expected initTimer to be cleared after initialized'
    );

    manager.destroy();
  });

  it('clears init timer on destroy before initialized', () => {
    const manager = new RootsManager({}, { minimumLevel: 'debug' });
    const fakeServer = createFakeServer();

    (
      manager as unknown as { updateRootsFromClient: () => Promise<void> }
    ).updateRootsFromClient = () => Promise.resolve();

    manager.registerHandlers(fakeServer.server);

    const timerBefore = (
      manager as unknown as { initTimer: ReturnType<typeof setTimeout> }
    ).initTimer;
    assert.ok(timerBefore, 'Expected initTimer to be set');

    manager.destroy();

    const timerAfter = (
      manager as unknown as {
        initTimer: ReturnType<typeof setTimeout> | undefined;
      }
    ).initTimer;
    assert.equal(
      timerAfter,
      undefined,
      'Expected initTimer to be cleared on destroy'
    );
  });
});
