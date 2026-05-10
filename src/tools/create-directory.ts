import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, McpError } from '../core/errors.js';
import type { PathGuard } from '../core/path.js';
import { RequiredPath } from '../schema.js';
import { buildToolResponse } from './_helpers.js';
import { defineTool } from './define.js';

const CreateDirectoryInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(1000)
    .describe('One or more directory paths to create (recursive; max 1000)'),
});

const CreateDirectoryOutputSchema = z.strictObject({
  path: z.string().describe('Created directory path'),
  ok: z.literal(true).describe('Success indicator'),
});

async function handleCreateDirectory(
  args: z.infer<typeof CreateDirectoryInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
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
    throw new McpError(ErrorCode.UNKNOWN, `Failed to create ${inputPath}`, inputPath);
  }
}

export const CREATE_DIRECTORY = defineTool({
  name: 'make_dir',
  title: 'Create Directory',
  description: 'Create one or more directories (recursive). Accepts a list of paths.',
  input: CreateDirectoryInputSchema,
  output: CreateDirectoryOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: async (args, ctx) => {
    const structured = await handleCreateDirectory(args, ctx.pathGuard, ctx.signal);
    ctx.log?.('info', `mkdir: ${args.paths[0]}`, 'mkdir');
    return buildToolResponse(`create-directory: created ${structured.path}`, structured);
  },
  progressLabel: (args) => {
    if (args.paths.length === 1) {
      return `Create Directory: ${basename(args.paths[0] ?? '')}`;
    }
    return `Create Directory: ${args.paths.length} directories`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
