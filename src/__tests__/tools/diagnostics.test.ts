import * as diagnosticsChannel from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerListAllowedDirectoriesTool } from '../../tools/list-allowed-dirs.js';
import {
  enableDiagnosticsEnv,
  restoreDiagnosticsEnv,
} from '../shared/diagnostics-env.js';

type ToolHandler = () => Promise<unknown>;

interface DiagnosticsSubscription {
  published: unknown[];
  unsubscribe: () => void;
}

function subscribeDiagnostics(channel: string): DiagnosticsSubscription {
  const published: unknown[] = [];
  const onMessage = (message: unknown): void => {
    published.push(message);
  };

  diagnosticsChannel.subscribe(channel, onMessage);

  return {
    published,
    unsubscribe: () => {
      diagnosticsChannel.unsubscribe(channel, onMessage);
    },
  };
}

function createFakeServerCapture(): {
  fakeServer: McpServer;
  getHandler: () => ToolHandler;
} {
  let captured: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (_name: string, _definition: unknown, handler: unknown) => {
      captured = handler as ToolHandler;
    },
  } as const;

  return {
    fakeServer: fakeServer as unknown as McpServer,
    getHandler: () => {
      assert.ok(captured);
      return captured;
    },
  };
}

async function invokeRootsTool(): Promise<void> {
  const { fakeServer, getHandler } = createFakeServerCapture();
  registerListAllowedDirectoriesTool(fakeServer);
  const handler = getHandler();
  await handler();
}

function filterToolEvents(
  published: unknown[]
): { tool?: unknown; phase?: unknown }[] {
  return published.filter(
    (value): value is { tool?: unknown; phase?: unknown } =>
      typeof value === 'object' && value !== null
  );
}

function filterPerfEvents(
  published: unknown[]
): { tool?: unknown; elu?: unknown }[] {
  return published.filter(
    (value): value is { tool?: unknown; elu?: unknown } =>
      typeof value === 'object' && value !== null
  );
}

function assertToolPhaseEvents(
  events: { tool?: unknown; phase?: unknown }[]
): void {
  const toolEvents = events.filter((event) => event.tool === 'roots');
  assert.ok(toolEvents.length >= 2);
  assert.ok(toolEvents.some((event) => event.phase === 'start'));
  assert.ok(toolEvents.some((event) => event.phase === 'end'));
}

function assertPerfEvents(events: { tool?: unknown; elu?: unknown }[]): void {
  const toolEvents = events.filter((event) => event.tool === 'roots');
  assert.ok(toolEvents.length >= 1);

  const withElu = toolEvents.find(
    (
      event
    ): event is {
      elu: { utilization?: unknown; idle?: unknown; active?: unknown };
    } => typeof event.elu === 'object' && event.elu !== null
  );
  assert.ok(withElu);
  assert.equal(typeof withElu.elu.utilization, 'number');
  assert.equal(typeof withElu.elu.idle, 'number');
  assert.equal(typeof withElu.elu.active, 'number');
}

await it('publishes tool diagnostics events when enabled', async () => {
  const envSnapshot = enableDiagnosticsEnv();
  const subscription = subscribeDiagnostics('fs-context:tool');

  try {
    await invokeRootsTool();
    const events = filterToolEvents(subscription.published);
    assertToolPhaseEvents(events);
  } finally {
    subscription.unsubscribe();
    restoreDiagnosticsEnv(envSnapshot);
  }
});

await it('publishes perf diagnostics events when enabled', async () => {
  const envSnapshot = enableDiagnosticsEnv();
  const subscription = subscribeDiagnostics('fs-context:perf');

  try {
    await invokeRootsTool();
    const events = filterPerfEvents(subscription.published);
    assertPerfEvents(events);
  } finally {
    subscription.unsubscribe();
    restoreDiagnosticsEnv(envSnapshot);
  }
});
