import type {
  McpServer,
  ReadResourceResult,
} from '@modelcontextprotocol/server';

import { withDefaultIcons } from '../tools/shared.js';
import type { ResourceContract } from './contract.js';
import {
  resourceMetadata,
  type ResourceRegistrationOptions,
} from './shared.js';
import { buildToolCatalog } from './tool-catalog.js';

const TOOL_CATALOG_URI = 'internal://tool-catalog';

export const TOOL_CATALOG_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-catalog',
  uri: TOOL_CATALOG_URI,
  title: 'Tool Catalog',
  description: 'Tool selection guide and data flow map.',
  mimeType: 'text/markdown',
  annotations: { audience: ['assistant'], priority: 0.7 },
};

export function registerToolCatalogResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  const content = buildToolCatalog();
  server.registerResource(
    TOOL_CATALOG_RESOURCE.name,
    TOOL_CATALOG_URI,
    withDefaultIcons(
      { ...resourceMetadata(TOOL_CATALOG_RESOURCE) },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }],
    })
  );
}
