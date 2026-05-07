import type {
  McpServer,
  ReadResourceResult,
} from '@modelcontextprotocol/server';

import { globalMetrics, onMetricsUpdate } from '../lib/observability.js';

import { withDefaultIcons } from '../tools/shared.js';
import type {
  ResourceContract,
  ResourceSubscriptionLifecycle,
} from './contract.js';
import {
  resourceMetadata,
  type ResourceRegistrationOptions,
} from './shared.js';

const METRICS_RESOURCE_URI = 'filesystem-mcp://metrics';

export const METRICS_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-metrics',
  uri: METRICS_RESOURCE_URI,
  title: 'Tool Metrics',
  description: 'Live per-tool call/error/avgDurationMs metrics snapshot.',
  mimeType: 'application/json',
  annotations: { audience: ['assistant'], priority: 0.5 },
  createSubscription: (notify): ResourceSubscriptionLifecycle => {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onMetricsUpdate(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        notify(METRICS_RESOURCE_URI);
      }, 500);
    });
    return {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onSubscribe: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      onUnsubscribe: () => {},
      destroy: () => {
        clearTimeout(debounceTimer);
        unsubscribe();
      },
    };
  },
};

export function registerMetricsResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    METRICS_RESOURCE.name,
    METRICS_RESOURCE_URI,
    withDefaultIcons(
      { ...resourceMetadata(METRICS_RESOURCE) },
      options.iconInfo
    ),
    (uri): ReadResourceResult => {
      const snapshot: Record<
        string,
        { calls: number; errors: number; avgDurationMs: number }
      > = {};
      for (const [tool, m] of globalMetrics) {
        snapshot[tool] = {
          calls: m.calls,
          errors: m.errors,
          avgDurationMs:
            m.calls > 0
              ? parseFloat((m.totalDurationMs / m.calls).toFixed(2))
              : 0,
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ ok: true, metrics: snapshot }, null, 2),
          },
        ],
      };
    }
  );
}
