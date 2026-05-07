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
import { buildWorkflowGuide } from './workflows.js';

const WORKFLOW_GUIDE_URI = 'internal://workflows';

export const WORKFLOW_GUIDE_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-workflows',
  uri: WORKFLOW_GUIDE_URI,
  title: 'Workflow Guide',
  description:
    'Standard operating procedures for exploration, search, edit, and patch.',
  mimeType: 'text/markdown',
  annotations: { audience: ['assistant'], priority: 0.6 },
};

export function registerWorkflowGuideResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  const content = buildWorkflowGuide();
  server.registerResource(
    WORKFLOW_GUIDE_RESOURCE.name,
    WORKFLOW_GUIDE_URI,
    withDefaultIcons(
      { ...resourceMetadata(WORKFLOW_GUIDE_RESOURCE) },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }],
    })
  );
}
