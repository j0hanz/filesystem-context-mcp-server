import type { ResourceContract } from './contract.js';
import { SLIM_INSTRUCTIONS_CONTENT } from './instructions-content.js';

export function createInstructionsResource(): ResourceContract {
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: 'Navigation guide for filesystem-mcp tools and constraints.',
    mimeType: 'text/markdown',
    uri: 'internal://instructions',
    annotations: { audience: ['assistant'], priority: 0.8 },
    read(uri) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: SLIM_INSTRUCTIONS_CONTENT,
          },
        ],
      };
    },
  };
}
