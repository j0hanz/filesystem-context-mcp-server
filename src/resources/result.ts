import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ResourceContract } from './contract.js';
import type { ResourceRegistrationOptions } from './shared.js';

export function createResultResource(options: ResourceRegistrationOptions): ResourceContract {
  return {
    name: 'filesystem-mcp-result',
    title: 'Cached Tool Result',
    description: 'Ephemeral cached tool output. Not listed via resources/list.',
    mimeType: 'text/plain',
    uriTemplate: 'filesystem-mcp://result/{id}',
    annotations: { audience: ['assistant'], priority: 0.3 },
    read(uri, variables) {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          'Cached result expired. Re-run the tool to regenerate.'
        );
      }
      
      const entry = options.resourceStore.getEntry(uri.toString());
      if (entry.kind === 'text') {
        return {
          contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: entry.text }],
        };
      }
      return {
        contents: [{
          uri: entry.uri,
          mimeType: entry.mimeType,
          blob: entry.data.toString('base64'),
        }],
      };
    }
  };
}
