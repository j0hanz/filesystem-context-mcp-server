import { ProtocolError, ProtocolErrorCode, type ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PathGuard } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import { registerAllResources } from '../../src/resources.js';

type RequestHandler = (
  req: { params: Record<string, string> },
  ctx: ServerContext,
) => Promise<void>;

describe('resources/subscribe with unknown URI', () => {
  it('throws ProtocolError(ResourceNotFound) when subscribing to an unknown URI', async () => {
    // Create a minimal mock PathGuard
    const mockPathGuard = {
      getAllowedDirectories: () => [],
    } as unknown as PathGuard;

    // Create fake server and capture handlers
    const handlers = new Map<string, RequestHandler>();
    const server = {
      registerResource: () => {
        /* no-op for test */
      },
      server: {
        setRequestHandler: (name: string, handler: RequestHandler) => {
          handlers.set(name, handler);
        },
        sendResourceUpdated: async () => {
          /* no-op */
        },
      },
    };

    const resourceStore = createInMemoryResourceStore();

    // Register resources
    registerAllResources(server as never, {
      resourceStore,
      pathGuard: mockPathGuard,
    });

    const subscribeHandler = handlers.get('resources/subscribe');
    assert.ok(subscribeHandler, 'Subscribe handler should be registered');

    // Create a fake server context
    const ctx: ServerContext = {
      sessionId: 'test-session',
    } as unknown as ServerContext;

    // Test: subscribe to an unknown URI should throw ProtocolError with ResourceNotFound
    // Use a URI that doesn't match any registered resource (use a different scheme)
    const unknownUri = 'http://example.com/resource';

    let thrownError: unknown;
    try {
      await subscribeHandler(
        {
          params: {
            uri: unknownUri,
          },
        },
        ctx,
      );
    } catch (error) {
      thrownError = error;
    }

    assert.ok(
      thrownError instanceof ProtocolError,
      `Should throw ProtocolError, got: ${thrownError instanceof Error ? thrownError.message : String(thrownError)}`,
    );
    assert.equal(
      thrownError.code,
      ProtocolErrorCode.ResourceNotFound,
      'Should have ResourceNotFound error code',
    );
  });
});
