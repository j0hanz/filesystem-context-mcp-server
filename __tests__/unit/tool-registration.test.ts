import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServerDeps } from '../../src/core/registrar.js';

describe('Tool Registration', () => {
  it('registers all tools except request_access', async () => {
    const { toolsRegistrar } = await import('../../src/tools/index.js');
    const registered: string[] = [];
    const mockDeps = {
      server: {
        registerTool(name: string) {
          registered.push(name);
        },
      },
      isInitialized: () => true,
      pathGuard: {},
      resourceStore: {},
    };

    toolsRegistrar.register(mockDeps as unknown as ServerDeps);

    assert.ok(!registered.includes('request_access'), 'request_access must NOT be registered');
    assert.ok(registered.includes('read'), 'Expected read to be registered');
    assert.ok(registered.includes('stat'), 'Expected stat to be registered');
  });
});
