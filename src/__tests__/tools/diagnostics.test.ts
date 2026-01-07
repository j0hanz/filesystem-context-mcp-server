import * as diagnosticsChannel from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerListAllowedDirectoriesTool } from '../../tools/list-allowed-dirs.js';

type ToolHandler = () => Promise<unknown>;

const restoreEnv = (key: string, previous: string | undefined): void => {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = previous;
};

await it('publishes tool diagnostics events when enabled', async () => {
  const previousEnabled = process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS;
  const previousDetail = process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL;
  process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS = '1';
  process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL = '0';

  const published: unknown[] = [];
  const onMessage = (message: unknown): void => {
    published.push(message);
  };
  diagnosticsChannel.subscribe('filesystem-context:tool', onMessage);

  try {
    let captured: ToolHandler | undefined;
    const fakeServer = {
      registerTool: (
        _name: string,
        _definition: unknown,
        handler: unknown
      ): void => {
        captured = handler as ToolHandler;
      },
    } as const;

    registerListAllowedDirectoriesTool(fakeServer as unknown as McpServer);
    assert.ok(captured);

    await captured();

    const events = published.filter(
      (value): value is { tool?: unknown; phase?: unknown } =>
        typeof value === 'object' && value !== null
    );
    const toolEvents = events.filter(
      (event) => event.tool === 'list_allowed_directories'
    );

    assert.ok(toolEvents.length >= 2);
    assert.ok(toolEvents.some((event) => event.phase === 'start'));
    assert.ok(toolEvents.some((event) => event.phase === 'end'));
  } finally {
    diagnosticsChannel.unsubscribe('filesystem-context:tool', onMessage);
    restoreEnv('FILESYSTEM_CONTEXT_DIAGNOSTICS', previousEnabled);
    restoreEnv('FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL', previousDetail);
  }
});
