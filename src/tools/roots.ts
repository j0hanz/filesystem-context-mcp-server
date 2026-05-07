import type { McpServer } from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';
import { getAllowedDirectories } from '../lib/paths.js';

import { joinLines } from '../config.js';
import {
  ListAllowedDirectoriesInputSchema,
  ListAllowedDirectoriesOutputSchema,
} from '../schemas.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const LIST_ALLOWED_DIRECTORIES_TOOL: ToolContract = {
  name: 'roots',
  title: 'Workspace Roots',
  description:
    'List allowed workspace roots. Call first \u2014 all other tools are scoped to these directories.',
  inputSchema: ListAllowedDirectoriesInputSchema,
  outputSchema: ListAllowedDirectoriesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  taskSupport: 'forbidden',
} as const;

function buildTextRoots(dirs: string[]): string {
  if (dirs.length === 0) {
    return 'No directories configured';
  }
  return joinLines([
    `${dirs.length} workspace roots:`,
    ...dirs.map((d) => `  ${d}`),
  ]);
}

function handleListAllowedDirectories(): ToolResponse<
  z.infer<typeof ListAllowedDirectoriesOutputSchema>
> {
  const dirs = getAllowedDirectories();
  const structured = {
    ok: true,
    directories: dirs,
  } as const;
  return buildToolResponse(buildTextRoots(dirs), structured);
}

export function registerListAllowedDirectoriesTool(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  const handler = (
    _args: z.infer<typeof ListAllowedDirectoriesInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof ListAllowedDirectoriesOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'roots',
      ctx,
      outputSchema: ListAllowedDirectoriesOutputSchema,
      run: () => handleListAllowedDirectories(),
      onError: (error) => buildToolErrorResponse(error, ErrorCode.UNKNOWN),
    });

  registerStandardTool(
    server,
    LIST_ALLOWED_DIRECTORIES_TOOL,
    handler,
    options,
    {
      progressMessage: () => LIST_ALLOWED_DIRECTORIES_TOOL.title,
      completionMessage: (_args, result) => {
        if (result.isError)
          return `${LIST_ALLOWED_DIRECTORIES_TOOL.title} • ${result.errorCode}`;
        const sc = result.structuredContent;
        const count = sc.directories?.length ?? 0;
        return `${LIST_ALLOWED_DIRECTORIES_TOOL.title} • ${count} ${count === 1 ? 'root' : 'roots'}`;
      },
    }
  );
}
