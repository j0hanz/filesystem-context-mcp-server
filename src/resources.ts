import {
  type McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode, McpError } from './lib/errors.js';
import { globalMetrics } from './lib/observability.js';
import type { ResourceStore } from './lib/resource-store.js';

import { buildToolCatalog } from './resources/tool-catalog.js';
import { buildToolInfo, getToolContracts } from './resources/tool-info.js';
import { buildWorkflowGuide } from './resources/workflows.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

const RESULT_TEMPLATE = new ResourceTemplate('filesystem-mcp://result/{id}', {
  list: undefined,
});

const TOOL_INFO_TEMPLATE = new ResourceTemplate('internal://tool-info/{name}', {
  list: () => ({
    resources: getToolContracts().map((contract) => ({
      uri: `internal://tool-info/${contract.name}`,
      name: contract.name,
      title: contract.title,
      description: contract.description,
      mimeType: 'text/markdown',
    })),
  }),
});
const TOOL_INFO_RESOURCE_NAME = 'filesystem-mcp-tool-info';
const TOOL_INFO_RESOURCE_DESCRIPTION =
  'Per-tool contract details, nuances, and gotchas. Read internal://tool-info/{name} with a tool name such as "read", "ls", or "grep".';

const INSTRUCTIONS_RESOURCE_NAME = 'filesystem-mcp-instructions';
const INSTRUCTIONS_RESOURCE_URI = 'internal://instructions';
const INSTRUCTIONS_RESOURCE_DESCRIPTION =
  'Comprehensive rules and guidelines for filesystem-mcp usage.';
const RESULT_RESOURCE_NAME = 'filesystem-mcp-result';
const RESULT_RESOURCE_DESCRIPTION =
  'Ephemeral cached tool output exposed as an MCP resource. Not guaranteed to be listed via resources/list.';

const METRICS_RESOURCE_NAME = 'filesystem-mcp-metrics';
const METRICS_RESOURCE_URI = 'filesystem-mcp://metrics';
const METRICS_RESOURCE_DESCRIPTION =
  'Live per-tool call/error/avgDurationMs metrics snapshot.';

const CATALOG_RESOURCE_NAME = 'filesystem-mcp-catalog';
const CATALOG_RESOURCE_URI = 'internal://tool-catalog';
const CATALOG_RESOURCE_DESCRIPTION = 'Tool selection guide and data flow map.';

const WORKFLOW_RESOURCE_NAME = 'filesystem-mcp-workflows';
const WORKFLOW_RESOURCE_URI = 'internal://workflows';
const WORKFLOW_RESOURCE_DESCRIPTION =
  'Standard operating procedures for exploration, search, edit, and patch.';

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
          ErrorCode.NOT_FOUND,
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

export function registerToolInfoResource(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerResource(
    TOOL_INFO_RESOURCE_NAME,
    TOOL_INFO_TEMPLATE,
    withDefaultIcons(
      {
        title: 'Tool Info',
        description: TOOL_INFO_RESOURCE_DESCRIPTION,
        mimeType: 'text/markdown',
        annotations: {
          audience: ['assistant'],
          priority: 0.65,
        },
      },
      iconInfo
    ),
    (uri, variables): ReadResourceResult => {
      const { name } = variables;
      if (typeof name !== 'string' || name.length === 0) {
        throw new McpError(ErrorCode.INVALID_INPUT, 'Tool name is required');
      }
      const content = buildToolInfo(name);
      if (content === undefined) {
        throw new McpError(ErrorCode.INVALID_INPUT, `Tool not found: ${name}`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: content,
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
