import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode, McpError } from './lib/errors.js';
import { globalMetrics } from './lib/observability.js';
import type { ResourceStore } from './lib/resource-store.js';
import { buildToolCatalog } from './resources/tool-catalog.js';
import { buildWorkflowGuide } from './resources/workflows.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

const RESULT_TEMPLATE = new ResourceTemplate('filesystem-mcp://result/{id}', {
  list: undefined,
});
const INSTRUCTIONS_RESOURCE_NAME = 'filesystem-mcp-instructions';
const INSTRUCTIONS_RESOURCE_URI = 'internal://instructions';
const INSTRUCTIONS_RESOURCE_DESCRIPTION =
  'Guidance for using the filesystem-mcp MCP tools effectively.';
const RESULT_RESOURCE_NAME = 'filesystem-mcp-result';
const RESULT_RESOURCE_DESCRIPTION =
  'Ephemeral cached tool output exposed as an MCP resource. Not guaranteed to be listed via resources/list.';

const METRICS_RESOURCE_NAME = 'filesystem-mcp-metrics';
const METRICS_RESOURCE_URI = 'filesystem-mcp://metrics';
const METRICS_RESOURCE_DESCRIPTION =
  'Live per-tool call/error/avgDurationMs metrics snapshot.';

const CATALOG_RESOURCE_NAME = 'filesystem-mcp-catalog';
const CATALOG_RESOURCE_URI = 'internal://tool-catalog';
const CATALOG_RESOURCE_DESCRIPTION =
  'Detailed catalog of tools and their inter-dependencies.';

const WORKFLOW_RESOURCE_NAME = 'filesystem-mcp-workflows';
const WORKFLOW_RESOURCE_URI = 'internal://workflows';
const WORKFLOW_RESOURCE_DESCRIPTION = 'Recommended workflows for common tasks.';

export function registerInstructionResource(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    INSTRUCTIONS_RESOURCE_NAME,
    INSTRUCTIONS_RESOURCE_URI,
    withDefaultIcons(
      {
        title: 'Server Instructions',
        description: INSTRUCTIONS_RESOURCE_DESCRIPTION,
        mimeType: 'text/markdown',
        annotations: {
          audience: ['assistant'],
          priority: 0.8,
        },
      },
      iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: instructions,
        },
      ],
    })
  );
}

export function registerToolCatalogResource(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    CATALOG_RESOURCE_NAME,
    CATALOG_RESOURCE_URI,
    withDefaultIcons(
      {
        title: 'Tool Catalog',
        description: CATALOG_RESOURCE_DESCRIPTION,
        mimeType: 'text/markdown',
        annotations: {
          audience: ['assistant'],
          priority: 0.7,
        },
      },
      iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: buildToolCatalog(),
        },
      ],
    })
  );
}

export function registerWorkflowGuideResource(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    WORKFLOW_RESOURCE_NAME,
    WORKFLOW_RESOURCE_URI,
    withDefaultIcons(
      {
        title: 'Workflow Guide',
        description: WORKFLOW_RESOURCE_DESCRIPTION,
        mimeType: 'text/markdown',
        annotations: {
          audience: ['assistant'],
          priority: 0.6,
        },
      },
      iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: buildWorkflowGuide(),
        },
      ],
    })
  );
}

export function registerResultResources(
  server: McpServer,
  store: ResourceStore,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    RESULT_RESOURCE_NAME,
    RESULT_TEMPLATE,
    withDefaultIcons(
      {
        title: 'Cached Tool Result',
        description: RESULT_RESOURCE_DESCRIPTION,
        mimeType: 'text/plain',
        annotations: {
          audience: ['assistant'],
          priority: 0.3,
        },
      },
      iconInfo
    ),
    (uri, variables): ReadResourceResult => {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new McpError(
          ErrorCode.E_NOT_FOUND,
          'Cached result has expired — re-run the tool to regenerate.'
        );
      }

      const entry = store.getText(uri.toString());

      return {
        contents: [
          {
            uri: entry.uri,
            mimeType: entry.mimeType,
            text: entry.text,
          },
        ],
      };
    }
  );
}

export function registerMetricsResource(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    METRICS_RESOURCE_NAME,
    METRICS_RESOURCE_URI,
    withDefaultIcons(
      {
        title: 'Tool Metrics',
        description: METRICS_RESOURCE_DESCRIPTION,
        mimeType: 'application/json',
        annotations: {
          audience: ['assistant'],
          priority: 0.5,
        },
      },
      iconInfo
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
