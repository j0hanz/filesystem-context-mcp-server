import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { ErrorCode } from '../lib/errors.js';
import { getAllowedDirectories } from '../lib/paths.js';

import { joinLines } from '../config.js';
import {
  ListAllowedDirectoriesInputSchema,
  ListAllowedDirectoriesOutputSchema,
} from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolExtra,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const LIST_ALLOWED_DIRECTORIES_TOOL: ToolContract = {
  name: 'roots',
  title: 'Workspace Roots',
  description:
    'List allowed workspace roots. Call first \u2014 all other tools are scoped to these directories.',
  inputSchema: ListAllowedDirectoriesInputSchema,
  outputSchema: ListAllowedDirectoriesOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
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
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    _args: z.infer<typeof ListAllowedDirectoriesInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof ListAllowedDirectoriesOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'roots',
      extra,
      outputSchema: ListAllowedDirectoriesOutputSchema,
      run: () => handleListAllowedDirectories(),
      onError: (error) => buildToolErrorResponse(error, ErrorCode.E_UNKNOWN),
    });

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    progressMessage: () => '≣ roots',
    completionMessage: (_args, result) => {
      if (result.isError) return `≣ roots • failed`;
      const sc = result.structuredContent;
      const count = sc.directories?.length ?? 0;
      return `≣ roots • ${count} ${count === 1 ? 'root' : 'roots'}`;
    },
  });

  const validatedHandler = withValidatedArgs(
    ListAllowedDirectoriesInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'roots',
      LIST_ALLOWED_DIRECTORIES_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'roots',
    withDefaultIcons({ ...LIST_ALLOWED_DIRECTORIES_TOOL }, options.iconInfo),
    validatedHandler
  );
}
