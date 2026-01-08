import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { joinLines } from '../config/formatting.js';
import { ErrorCode } from '../lib/errors.js';
import { withToolDiagnostics } from '../lib/observability/diagnostics.js';
import { getAllowedDirectories } from '../lib/path-validation/allowed-directories.js';
import {
  ListAllowedDirectoriesInputSchema,
  ListAllowedDirectoriesOutputSchema,
} from '../schemas/index.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  type ToolResponse,
  type ToolResult,
  withToolErrorHandling,
} from './tool-response.js';

type ListAllowedDirectoriesStructuredResult = z.infer<
  typeof ListAllowedDirectoriesOutputSchema
>;

function buildTextResult(dirs: string[]): string {
  if (dirs.length === 0) {
    return 'No directories configured';
  }
  return joinLines([
    `${dirs.length} workspace roots:`,
    ...dirs.map((d) => `  ${d}`),
  ]);
}

function handleListAllowedDirectories(): ToolResponse<ListAllowedDirectoriesStructuredResult> {
  const dirs = getAllowedDirectories();
  const structured: ListAllowedDirectoriesStructuredResult = {
    ok: true,
    directories: dirs,
  };
  return buildToolResponse(buildTextResult(dirs), structured);
}

const LIST_ALLOWED_DIRECTORIES_TOOL = {
  title: 'Workspace Roots',
  description:
    'List the workspace roots this server can access. ' +
    'Call this first to see available directories. ' +
    'All other tools only work within these directories.',
  inputSchema: ListAllowedDirectoriesInputSchema,
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
        withToolDiagnostics('roots', () =>
          Promise.resolve(handleListAllowedDirectories())
        ),
      (error) => buildToolErrorResponse(error, ErrorCode.E_UNKNOWN)
    );

  server.registerTool('roots', LIST_ALLOWED_DIRECTORIES_TOOL, handler);
}
