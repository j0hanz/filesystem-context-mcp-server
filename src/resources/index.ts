import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { getAllowedDirectories } from '../lib/path-validation.js';

export function registerAllResources(server: McpServer): void {
  // Static resource: allowed directories configuration
  server.registerResource(
    'allowed-directories',
    'config://allowed-directories',
    {
      title: 'Allowed Directories',
      description:
        'List of directories this server is permitted to access. ' +
        'All filesystem operations are sandboxed to these paths.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              allowedDirectories: getAllowedDirectories(),
              count: getAllowedDirectories().length,
            },
            null,
            2
          ),
        },
      ],
    })
  );

  // Static resource: server capabilities summary
  server.registerResource(
    'server-info',
    'config://server-info',
    {
      title: 'Server Information',
      description:
        'Summary of available tools, their purposes, and usage guidelines.',
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              name: 'filesystem-context-mcp',
              type: 'read-only',
              toolCategories: {
                discovery: [
                  'list_allowed_directories',
                  'directory_tree',
                  'list_directory',
                ],
                search: ['search_files', 'search_content'],
                read: ['read_file', 'read_multiple_files', 'read_media_file'],
                analysis: ['analyze_directory', 'get_file_info'],
              },
              security: {
                readOnly: true,
                pathValidation: true,
                symlinkProtection: true,
              },
            },
            null,
            2
          ),
        },
      ],
    })
  );
}
