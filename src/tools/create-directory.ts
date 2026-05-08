import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import type { PathGuard } from '../lib/path-guard.js';
import { RequiredPath } from '../schemas/fields.js';

import { defineTool } from './define-tool.js';
import { DIR_CREATE_ICONS } from './icons.js';
import {
  buildToolResponse,
  IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const CreateDirectoryInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .describe('One or more directory paths to create (recursive)'),
});

const CreateDirectoryOutputSchema = z.strictObject({
  path: z.string().describe('Created directory path'),
  ok: z.literal(true).describe('Success indicator'),
});

const CREATE_DIRECTORY_TOOL: ToolContract = {
  name: 'mkdir',
  title: 'Create Directory',
  description:
    'Create one or more directories (recursive). Accepts a list of paths.',
  inputSchema: CreateDirectoryInputSchema,
  outputSchema: CreateDirectoryOutputSchema,
  annotations: IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  icons: DIR_CREATE_ICONS,
  taskSupport: 'forbidden',
} as const;

async function handleCreateDirectory(
  args: z.infer<typeof CreateDirectoryInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal
): Promise<z.infer<typeof CreateDirectoryOutputSchema>> {
  // P3 confirmation-only pattern: process single path (use first path)
  const inputPath = args.paths[0];
  if (!inputPath) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'No paths provided.');
  }

  try {
    const validPath = await pathGuard.validatePathForWrite(inputPath);
    await withAbort(mkdir(validPath, { recursive: true }), signal);
    return {
      ok: true as const,
      path: validPath,
    };
  } catch (error) {
    // Re-throw McpErrors (e.g. ACCESS_DENIED) — security violations must not be silenced
    if (error instanceof McpError) throw error;
    throw new McpError(
      ErrorCode.UNKNOWN,
      `Failed to create ${inputPath}`,
      inputPath
    );
  }
}

export const CREATE_DIRECTORY = defineTool<
  z.infer<typeof CreateDirectoryInputSchema>,
  z.infer<typeof CreateDirectoryOutputSchema>
>({
  contract: CREATE_DIRECTORY_TOOL,
  run: async (args, ctx) => {
    const structured = await handleCreateDirectory(
      args,
      ctx.pathGuard,
      ctx.signal
    );
    // P3 confirmation-only pattern: terse summary with creation confirmation
    const summary = `create-directory: created ${structured.path}`;
    void ctx.log?.('info', `mkdir: ${args.paths[0]}`, 'mkdir');
    return buildToolResponse(summary, structured);
  },
  progressMessage: (args) => {
    if (args.paths.length === 1) {
      return `${CREATE_DIRECTORY_TOOL.title}: ${basename(args.paths[0] ?? '')}`;
    }
    return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories`;
  },
  completionMessage: (args, result) => {
    if (args.paths.length === 1) {
      const name = basename(args.paths[0] ?? '');
      if (result.isError)
        return `${CREATE_DIRECTORY_TOOL.title}: ${name} • ${result.errorCode}`;
      return `${CREATE_DIRECTORY_TOOL.title}: created ${result.structuredContent.path}`;
    }
    if (result.isError)
      return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories • ${result.errorCode}`;
    return `${CREATE_DIRECTORY_TOOL.title}: created ${result.structuredContent.path}`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
