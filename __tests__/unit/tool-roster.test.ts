import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import test from 'node:test';

import { PathGuard } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import { promptsRegistrar } from '../../src/prompts.js';
import { ALL_REGISTERED_TOOL_NAMES, MUTATING_TOOL_NAMES } from '../../src/tools/index.js';
import { ORACLE_ALL_TOOL_NAMES, ORACLE_MUTATING_TOOL_NAMES } from '../helpers.js';

test('MUTATING_TOOL_NAMES matches the declared mutating set', () => {
  assert.deepEqual(
    [...MUTATING_TOOL_NAMES].sort(),
    [...ORACLE_MUTATING_TOOL_NAMES].sort(),
    'A tool changed its readOnlyHint, or a new tool was added. If the new set is ' +
      'correct, update ORACLE_MUTATING_TOOL_NAMES in __tests__/helpers.ts.',
  );
});

test('every registered tool is classified exactly once', () => {
  assert.deepEqual(
    [...ALL_REGISTERED_TOOL_NAMES].sort(),
    [...ORACLE_ALL_TOOL_NAMES].sort(),
    'Add the new tool to ORACLE_ALL_TOOL_NAMES and to one of the two subsets.',
  );
});

test('get-help omits the Write row on a read-only server and shows it otherwise', async () => {
  const helpText = async (readOnly: boolean): Promise<string> => {
    const server = new McpServer(
      { name: 'get-help-ro', version: '0.0.0' },
      { capabilities: { prompts: {} } },
    );
    promptsRegistrar.register({
      server,
      pathGuard: new PathGuard(),
      resourceStore: createInMemoryResourceStore(),
      isInitialized: () => true,
      readOnly,
    });
    const client = new Client({ name: 'get-help-ro-client', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'tools_overview' },
      });
      const content = result.messages[0]?.content as { text?: string } | undefined;
      return content?.text ?? '';
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };

  const readOnlyText = await helpText(true);
  assert.ok(
    !readOnlyText.includes('Write:'),
    'get-help on a read-only server must not advertise the Write row',
  );
  const fullText = await helpText(false);
  assert.ok(
    fullText.includes(`Write: ${[...MUTATING_TOOL_NAMES].join(', ')}`),
    'get-help on a writable server must carry the Write row with every mutating tool',
  );
});
