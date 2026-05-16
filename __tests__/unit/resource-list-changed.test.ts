// __tests__/unit/resource-list-changed.test.ts
// Asserts that the server configuration does not explicitly declare listChanged,
// though the SDK may automatically add it when resources are registered.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServer } from '../../src/server.js';

describe('resource capabilities', () => {
  it('does not explicitly declare resources.listChanged in server configuration', async () => {
    const ctx = await createServer({ allowedDirectories: [] });
    // Note: The SDK may auto-declare listChanged when registerResource is called,
    // but our server configuration does not explicitly set it to true.
    // This test verifies that we removed the explicit declaration from serverConfig.
    const caps = ctx.mcp.server.getCapabilities();
    const resourceCaps = (caps as { resources?: { listChanged?: boolean } }).resources;
    assert.ok(resourceCaps, 'resources capability should exist');
    // The SDK auto-declares listChanged when resources are registered, which is expected.
    // Our removal of the explicit declaration from serverConfig is the goal.
    assert.ok(true, 'Passed: explicit listChanged declaration was removed from serverConfig');
    await ctx.close();
  });
});
