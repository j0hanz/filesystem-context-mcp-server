import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { formatAllowedDirectories } from '../lib/formatters.js';
import { getAllowedDirectories } from '../lib/path-validation.js';
import { ListAllowedDirectoriesOutputSchema } from '../schemas/index.js';

export function registerListAllowedDirectoriesTool(server: McpServer): void {
  server.registerTool(
    'list_allowed_directories',
    {
      title: 'List Allowed Directories',
      description:
        'Returns the list of directories this server is permitted to access. ' +
        'Call this FIRST to understand the scope of available file operations. ' +
        'All other tools will only work within these directories for security.',
      inputSchema: {},
      outputSchema: ListAllowedDirectoriesOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => {
      const dirs = getAllowedDirectories();
      const count = dirs.length;
      const hint =
        count === 0
          ? 'No directories configured. Server cannot access any files.'
          : count === 1
            ? 'Single directory configured. All operations are sandboxed here.'
            : `${count} directories configured. Operations work across all of them.`;

      const structured = {
        ok: true,
        allowedDirectories: dirs,
        count,
        hint,
      };
      return {
        content: [{ type: 'text', text: formatAllowedDirectories(dirs) }],
        structuredContent: structured,
      };
    }
  );
}
