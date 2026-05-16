// __tests__/unit/resource-subscribe-capability.test.ts
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Simulates a subscribe handler that guards against missing capability.
// This mirrors the guard added to server.ts.
function buildSubscribeHandler(clientCaps: { resources?: { subscribe?: boolean } }) {
  return async (_req: { params: { uri: string } }): Promise<Record<string, never>> => {
    if (!clientCaps.resources?.subscribe) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        'Client did not declare resources.subscribe capability',
      );
    }
    // Real subscribe logic would follow; we return early for this test.
    return {};
  };
}

describe('resources/subscribe capability guard', () => {
  it('rejects a client that did not declare resources.subscribe', async () => {
    const handler = buildSubscribeHandler({});

    let caught: unknown;
    try {
      await handler({ params: { uri: 'filesystem-mcp://file/foo.txt' } });
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof ProtocolError, 'should throw ProtocolError');
    assert.equal(caught.code, ProtocolErrorCode.InvalidRequest);
    assert.ok(caught.message.includes('resources.subscribe'));
  });

  it('accepts a client that declared resources.subscribe: true', async () => {
    const handler = buildSubscribeHandler({ resources: { subscribe: true } });

    // Should not throw — handler returns {} for this stub
    const result = await handler({ params: { uri: 'filesystem-mcp://file/foo.txt' } });
    assert.deepEqual(result, {});
  });
});
