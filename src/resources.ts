import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import type { ResourceStore } from './lib/resource-store.js';

import { SLIM_INSTRUCTIONS_CONTENT } from './resources/instructions-content.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
}

export { SLIM_INSTRUCTIONS_CONTENT as serverInstructionsContent };

const INSTRUCTIONS_URI = 'internal://instructions';
const RESULT_TEMPLATE = new ResourceTemplate('filesystem-mcp://result/{id}', {
  list: undefined,
});

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    'filesystem-mcp-instructions',
    INSTRUCTIONS_URI,
    withDefaultIcons(
      {
        title: 'Server Instructions',
        description:
          'Navigation guide for filesystem-mcp tools and constraints.',
        mimeType: 'text/markdown',
        annotations: { audience: ['assistant'], priority: 0.8 },
      },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: SLIM_INSTRUCTIONS_CONTENT,
        },
      ],
    })
  );

  server.registerResource(
    'filesystem-mcp-result',
    RESULT_TEMPLATE,
    withDefaultIcons(
      {
        title: 'Cached Tool Result',
        description:
          'Ephemeral cached tool output. Not listed via resources/list.',
        mimeType: 'text/plain',
        annotations: { audience: ['assistant'], priority: 0.3 },
      },
      options.iconInfo
    ),
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
        contents: [
          { uri: entry.uri, mimeType: entry.mimeType, text: entry.text },
        ],
      };
    }
  );
}
