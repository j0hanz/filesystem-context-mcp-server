import { JSONRPC_VERSION } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const __dirname = import.meta.dirname;

test('JSONRPC_VERSION constant', async (t) => {
  await t.test('JSONRPC_VERSION exports as "2.0"', () => {
    assert.strictEqual(JSONRPC_VERSION, '2.0', 'JSONRPC_VERSION should equal "2.0"');
  });

  await t.test('transport.ts uses JSONRPC_VERSION instead of hardcoded "2.0"', () => {
    // Read the source transport.ts to verify no hardcoded literals
    const transportPath = join(__dirname, '../../src/transport.ts');
    const transportSource = readFileSync(transportPath, 'utf-8');

    // Count occurrences of jsonrpc: '2.0' (hardcoded literal)
    const hardcodedMatches = transportSource.match(/jsonrpc:\s*['"]2\.0['"]/g);
    assert.strictEqual(
      hardcodedMatches?.length ?? 0,
      0,
      'transport.js should not contain hardcoded jsonrpc: "2.0" literals',
    );

    // Verify that JSONRPC_VERSION is used (check for the exported name or assignment)
    const usesConstant = transportSource.includes('JSONRPC_VERSION');
    assert.ok(usesConstant, 'transport.js should reference JSONRPC_VERSION constant');
  });
});
