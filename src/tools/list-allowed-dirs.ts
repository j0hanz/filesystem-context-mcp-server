import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DirectoryAccess } from '../config/types.js';
import { formatAllowedDirectories } from '../lib/formatters.js';
import { getAllowedDirectories } from '../lib/path-validation.js';
import { ListAllowedDirectoriesOutputSchema } from '../schemas/index.js';

async function checkDirectoryAccess(dirPath: string): Promise<DirectoryAccess> {
  try {
    await fs.access(dirPath, fs.constants.R_OK);
    return { path: dirPath, accessible: true, readable: true };
  } catch {
    try {
      await fs.access(dirPath, fs.constants.F_OK);
      return { path: dirPath, accessible: true, readable: false };
    } catch {
      return { path: dirPath, accessible: false, readable: false };
    }
  }
}

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
    async () => {
      const dirs = getAllowedDirectories();
      const count = dirs.length;
      const hint =
        count === 0
          ? 'No directories configured. Server cannot access any files.'
          : count === 1
            ? 'Single directory configured. All operations are sandboxed here.'
            : `${count} directories configured. Operations work across all of them.`;

      // Check access status for each directory
      const accessStatus = await Promise.all(dirs.map(checkDirectoryAccess));

      const structured = {
        ok: true,
        allowedDirectories: dirs,
        count,
        accessStatus,
        hint,
      };
      return {
        content: [{ type: 'text', text: formatAllowedDirectories(dirs) }],
        structuredContent: structured,
      };
    }
  );
}
