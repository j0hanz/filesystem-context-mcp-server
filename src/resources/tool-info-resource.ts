import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import { withDefaultIcons } from '../tools/shared.js';
import type { ResourceContract } from './contract.js';
import {
  resourceMetadata,
  type ResourceRegistrationOptions,
} from './shared.js';
import {
  buildToolInfo,
  getSortedToolContracts,
  getToolContracts,
} from './tool-info.js';

const TOOL_INFO_URI_TEMPLATE = 'internal://tool-info/{name}';

function filterToolNames(value: string): string[] {
  const toolNames = getSortedToolContracts().map((c) => c.name);
  const lower = value.toLowerCase();
  return lower ? toolNames.filter((n) => n.startsWith(lower)) : [...toolNames];
}

const TOOL_INFO_TEMPLATE = new ResourceTemplate(TOOL_INFO_URI_TEMPLATE, {
  list: () => ({
    resources: getToolContracts().map((contract) => ({
      uri: `internal://tool-info/${contract.name}`,
      name: contract.name,
      title: contract.title,
      description: contract.description,
      mimeType: 'text/markdown',
    })),
  }),
  complete: {
    name: (value) => filterToolNames(value),
  },
});

export const TOOL_INFO_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-tool-info',
  uriTemplate: TOOL_INFO_URI_TEMPLATE,
  title: 'Tool Info',
  description:
    'Per-tool contract details, nuances, and gotchas. Read internal://tool-info/{name} with a tool name such as "read", "ls", or "grep".',
  mimeType: 'text/markdown',
  annotations: { audience: ['assistant'], priority: 0.65 },
};

export function registerToolInfoResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    TOOL_INFO_RESOURCE.name,
    TOOL_INFO_TEMPLATE,
    withDefaultIcons(
      { ...resourceMetadata(TOOL_INFO_RESOURCE) },
      options.iconInfo
    ),
    (uri, variables): ReadResourceResult => {
      const { name } = variables;
      if (typeof name !== 'string' || name.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Tool name is required'
        );
      }
      const content = buildToolInfo(name);
      if (content === undefined) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool not found: ${name}`
        );
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }],
      };
    }
  );
}
