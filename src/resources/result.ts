import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import { withDefaultIcons } from '../tools/shared.js';
import type { ResourceContract } from './contract.js';
import { resourceMetadata, type ResourceRegistrationOptions } from './shared.js';

const RESULT_URI_TEMPLATE = 'filesystem-mcp://result/{id}';

const RESULT_TEMPLATE = new ResourceTemplate(RESULT_URI_TEMPLATE, {
  list: undefined,
});

export const RESULT_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-result',
  uriTemplate: RESULT_URI_TEMPLATE,
  title: 'Cached Tool Result',
  description:
    'Ephemeral cached tool output exposed as an MCP resource. Not guaranteed to be listed via resources/list.',
  mimeType: 'text/plain',
  annotations: { audience: ['assistant'], priority: 0.3 },
};

export function registerResultResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    RESULT_RESOURCE.name,
    RESULT_TEMPLATE,
    withDefaultIcons({ ...resourceMetadata(RESULT_RESOURCE) }, options.iconInfo),
    (uri, variables): ReadResourceResult => {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          'Cached result expired. Re-run the tool to regenerate.'
        );
      }
      const entry = options.resourceStore.getText(uri.toString());
      return {
        contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: entry.text }],
      };
    }
  );
}
