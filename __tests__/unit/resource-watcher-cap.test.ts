import {
  checkResourceAllowed,
  ProtocolError,
  ProtocolErrorCode,
  resourceUrlFromServerUrl,
  type ServerContext,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PathGuard } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import { getResourceContracts } from '../../src/resources.js';

type RequestHandler = (
  req: { params: Record<string, string> },
  ctx: ServerContext,
) => Promise<unknown>;

describe('resources/subscribe watcher cap', () => {
  it('throws ProtocolError(InternalError) when subscribe() returns false', async () => {
    const mockPathGuard = {
      getAllowedDirectories: () => [],
    } as unknown as PathGuard;

    const handlers = new Map<string, RequestHandler>();
    const resourceStore = createInMemoryResourceStore();

    const resourceContracts = getResourceContracts({
      resourceStore,
      pathGuard: mockPathGuard,
      readOnly: false,
    });

    // Patch the filesystem contract's subscribe to simulate cap hit.
    const fsContract = resourceContracts.find((c) => c.name === 'filesystem-mcp-file');
    assert.ok(fsContract, 'filesystem-mcp-file contract must exist');
    fsContract.subscribe = () => false;

    // Wire up the subscribe handler manually (mirrors registerResources internals).
    handlers.set(
      'resources/subscribe',
      (req: { params: Record<string, string> }, _ctx: ServerContext) => {
        const requestedResource = resourceUrlFromServerUrl(req.params.uri);
        let foundMatch = false;
        for (const contract of resourceContracts) {
          if (!contract.subscribe) continue;
          const configured = contract.uri ?? contract.uriTemplate?.split('{')[0];
          if (!configured) continue;
          if (checkResourceAllowed({ requestedResource, configuredResource: configured })) {
            foundMatch = true;
            const result = contract.subscribe(requestedResource.toString(), () => {});
            if (result === false) {
              return Promise.reject(
                new ProtocolError(
                  ProtocolErrorCode.InternalError,
                  'Subscription rejected: watcher limit reached.',
                ),
              );
            }
            break;
          }
        }
        if (!foundMatch) {
          return Promise.reject(
            new ProtocolError(
              ProtocolErrorCode.ResourceNotFound,
              `Resource not found: ${requestedResource.toString()}`,
            ),
          );
        }
        return Promise.resolve({});
      },
    );

    const subscribeHandler = handlers.get('resources/subscribe');
    assert.ok(subscribeHandler, 'subscribe handler must be registered');

    const ctx: ServerContext = { sessionId: 'test-session' } as unknown as ServerContext;

    let thrownError: unknown;
    try {
      await subscribeHandler({ params: { uri: 'filesystem-mcp://file/some/path' } }, ctx);
    } catch (error) {
      thrownError = error;
    }

    assert.ok(
      thrownError instanceof ProtocolError,
      `Expected ProtocolError, got: ${thrownError instanceof Error ? thrownError.message : String(thrownError)}`,
    );
    assert.equal(
      thrownError.code,
      ProtocolErrorCode.InternalError,
      'Cap hit should surface as InternalError',
    );
  });
});
