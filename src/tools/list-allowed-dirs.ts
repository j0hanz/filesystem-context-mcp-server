import * as fs from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { ErrorCode, isNodeError } from '../lib/errors.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { getAllowedDirectories } from '../lib/path-validation.js';
import { ListAllowedDirectoriesOutputSchema } from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

interface DirectoryAccess {
  path: string;
  accessible: boolean;
  readable: boolean;
}

type DirectoryAccessStatus = Omit<DirectoryAccess, 'path'>;

const ACCESS_STATUS_BY_CODE: Record<string, DirectoryAccessStatus> = {
  EACCES: { accessible: true, readable: false },
  EPERM: { accessible: true, readable: false },
  ENOENT: { accessible: false, readable: false },
  ENOTDIR: { accessible: false, readable: false },
};

function buildTextResult(
  dirs: string[],
  accessStatus: DirectoryAccess[]
): string {
  if (dirs.length === 0) {
    return 'No directories allowed.';
  }

  const accessByPath = new Map(
    accessStatus.map((status) => [status.path, status])
  );

  const lines = dirs.map((dir) => {
    const access = accessByPath.get(dir);
    const tag = buildAccessTag(access);
    return tag ? `${dir} ${tag}` : dir;
  });

  return joinLines([`Allowed directories (${dirs.length}):`, ...lines]);
}

function buildAccessTag(
  access: DirectoryAccess | undefined
): string | undefined {
  if (!access) return undefined;
  if (!access.accessible) return '[inaccessible]';
  if (!access.readable) return '[no read access]';
  return '[readable]';
}

function resolveAccessFromError(
  error: unknown,
  dirPath: string
): DirectoryAccess {
  if (!isNodeError(error)) {
    return { path: dirPath, accessible: false, readable: false };
  }

  const status = error.code ? ACCESS_STATUS_BY_CODE[error.code] : undefined;
  if (!status) {
    return { path: dirPath, accessible: false, readable: false };
  }

  return { path: dirPath, ...status };
}

async function checkDirectoryAccess(dirPath: string): Promise<DirectoryAccess> {
  try {
    const dir = await fs.opendir(dirPath);
    await dir.close();
    return { path: dirPath, accessible: true, readable: true };
  } catch (error) {
    return resolveAccessFromError(error, dirPath);
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

  return buildToolResponse(buildTextResult(dirs, accessStatus), structured);
}

const LIST_ALLOWED_DIRECTORIES_TOOL = {
  title: 'List Allowed Directories',
  description:
    'List the directories this server is permitted to access, plus access status. ' +
    'Call this first to understand the scope of available file operations. ' +
    'All other tools only work within these directories for security.',
  outputSchema: ListAllowedDirectoriesOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

export function registerListAllowedDirectoriesTool(server: McpServer): void {
  const handler = (): Promise<
    ToolResult<ListAllowedDirectoriesStructuredResult>
  > =>
    withToolErrorHandling(
      () =>
        withToolDiagnostics(
          'list_allowed_directories',
          handleListAllowedDirectories
        ),
      (error) => buildToolErrorResponse(error, ErrorCode.E_UNKNOWN)
    );

  server.registerTool(
    'list_allowed_directories',
    LIST_ALLOWED_DIRECTORIES_TOOL,
    handler
  );
}
