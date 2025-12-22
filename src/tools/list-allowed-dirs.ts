import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { getAllowedDirectories } from '../lib/path-validation.js';
import { ListAllowedDirectoriesOutputSchema } from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

interface DirectoryAccess {
  path: string;
  accessible: boolean;
  readable: boolean;
}

function formatAllowedDirectories(dirs: string[]): string {
  if (dirs.length === 0) {
    return 'No directories are currently allowed.';
  }

  const lines = ['Allowed Directories:', ''];
  for (const dir of dirs) {
    lines.push(`  - ${dir}`);
  }

  return lines.join('\n');
}

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

function buildHint(count: number): string {
  if (count === 0) {
    return 'No directories configured. Server cannot access any files.';
  }
  if (count === 1) {
    return 'Single directory configured. All operations are sandboxed here.';
  }
  return `${count} directories configured. Operations work across all of them.`;
}

type ListAllowedDirectoriesStructuredResult = z.infer<
  typeof ListAllowedDirectoriesOutputSchema
>;

async function handleListAllowedDirectories(): Promise<
  ToolResponse<ListAllowedDirectoriesStructuredResult>
> {
  const dirs = getAllowedDirectories();
  const count = dirs.length;
  const hint = buildHint(count);
  const accessStatus = await Promise.all(dirs.map(checkDirectoryAccess));

  const structured: ListAllowedDirectoriesStructuredResult = {
    ok: true,
    allowedDirectories: dirs,
    count,
    accessStatus,
    hint,
  };

  return buildToolResponse(formatAllowedDirectories(dirs), structured);
}

const LIST_ALLOWED_DIRECTORIES_TOOL = {
  title: 'List Allowed Directories',
  description:
    'Returns the list of directories this server is permitted to access. ' +
    'Call this FIRST to understand the scope of available file operations. ' +
    'All other tools will only work within these directories for security.',
  inputSchema: {},
  outputSchema: ListAllowedDirectoriesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export function registerListAllowedDirectoriesTool(server: McpServer): void {
  server.registerTool(
    'list_allowed_directories',
    LIST_ALLOWED_DIRECTORIES_TOOL,
    async () => await handleListAllowedDirectories()
  );
}
