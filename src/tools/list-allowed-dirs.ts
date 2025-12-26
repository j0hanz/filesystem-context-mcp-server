import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, isNodeError } from '../lib/errors.js';
import { getAllowedDirectories } from '../lib/path-validation.js';
import { ListAllowedDirectoriesOutputSchema } from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
} from './tool-response.js';

interface DirectoryAccess {
  path: string;
  accessible: boolean;
  readable: boolean;
}

function formatAllowedDirectories(
  dirs: string[],
  accessStatus: DirectoryAccess[]
): string {
  if (dirs.length === 0) {
    return 'No directories are currently allowed.';
  }

  const lines = ['Allowed Directories:', ''];
  for (const dir of dirs) {
    const access = accessStatus.find((a) => a.path === dir);
    const tag = buildAccessTag(access);
    lines.push(tag ? `  - ${dir} ${tag}` : `  - ${dir}`);
  }

  return lines.join('\n');
}

function buildAccessTag(
  access: DirectoryAccess | undefined
): string | undefined {
  if (!access) return undefined;
  if (!access.accessible) return '[inaccessible]';
  if (!access.readable) return '[no read access]';
  return '[readable]';
}

async function checkDirectoryAccess(dirPath: string): Promise<DirectoryAccess> {
  try {
    const dir = await fs.opendir(dirPath);
    await dir.close();
    return { path: dirPath, accessible: true, readable: true };
  } catch (error) {
    if (isNodeError(error)) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return { path: dirPath, accessible: true, readable: false };
      }
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return { path: dirPath, accessible: false, readable: false };
      }
    }
    return { path: dirPath, accessible: false, readable: false };
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

  return buildToolResponse(
    formatAllowedDirectories(dirs, accessStatus),
    structured
  );
}

const LIST_ALLOWED_DIRECTORIES_TOOL = {
  title: 'List Allowed Directories',
  description:
    'Returns the list of directories this server is permitted to access. ' +
    'Call this FIRST to understand the scope of available file operations. ' +
    'All other tools will only work within these directories for security.',
  outputSchema: ListAllowedDirectoriesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

const LIST_ALLOWED_DIRECTORIES_TOOL_DEPRECATED = {
  ...LIST_ALLOWED_DIRECTORIES_TOOL,
  description: `${LIST_ALLOWED_DIRECTORIES_TOOL.description} (Deprecated: use listAllowedDirectories.)`,
} as const;

export function registerListAllowedDirectoriesTool(server: McpServer): void {
  const handler = async (): Promise<
    ToolResult<ListAllowedDirectoriesStructuredResult>
  > => {
    try {
      return await handleListAllowedDirectories();
    } catch (error: unknown) {
      return buildToolErrorResponse(error, ErrorCode.E_UNKNOWN);
    }
  };

  server.registerTool(
    'list_allowed_directories',
    LIST_ALLOWED_DIRECTORIES_TOOL_DEPRECATED,
    handler
  );
  server.registerTool(
    'listAllowedDirectories',
    LIST_ALLOWED_DIRECTORIES_TOOL,
    handler
  );
}
