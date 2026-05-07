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

const INSTRUCTIONS_URI = 'internal://instructions';

export const INSTRUCTIONS_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-instructions',
  uri: INSTRUCTIONS_URI,
  title: 'Server Instructions',
  description: 'Comprehensive rules and guidelines for filesystem-mcp usage.',
  mimeType: 'text/markdown',
  annotations: { audience: ['assistant'], priority: 0.8 },
};

export function registerInstructionResource(
  server: McpServer,
  content: string,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    INSTRUCTIONS_RESOURCE.name,
    INSTRUCTIONS_URI,
    withDefaultIcons(
      { ...resourceMetadata(INSTRUCTIONS_RESOURCE) },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }],
    })
  );
}
