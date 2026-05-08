import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode, McpError } from '../lib/errors.js';
import type { PathGuard } from '../lib/path-guard.js';
import { RequiredPath } from '../schemas/fields.js';
import {
  OperationSummarySchema,
  PerFileErrorSchema,
} from '../schemas/shared.js';

import { defineTool } from './define-tool.js';
import { DIR_CREATE_ICONS } from './icons.js';
import {
  buildStructuredError,
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
  ok: z.literal(true).describe('Success indicator'),
  created: z
    .array(
      z.strictObject({
        path: z.string().describe('Created directory path'),
        isNew: z.boolean().describe('Was directory newly created'),
      })
    )
    .describe('Created directories'),
  summary: OperationSummarySchema.describe('Operation summary'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      })
    )
    .optional()
    .describe('Per-path failures'),
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
  const created: { path: string; isNew: boolean }[] = [];
  const failures: {
    path: string;
    error: {
      code: string;
      message: string;
      path?: string;
      suggestion?: string;
    };
  }[] = [];

  for (const p of args.paths) {
    try {
      const validPath = await pathGuard.validatePathForWrite(p);
      const result = await withAbort(
        mkdir(validPath, { recursive: true }),
        signal
      );
      created.push({ path: validPath, isNew: result !== undefined });
    } catch (error) {
      // Re-throw McpErrors (e.g. ACCESS_DENIED) — security violations must not be silenced
      if (error instanceof McpError) throw error;
      failures.push({
        path: p,
        error: buildStructuredError(error, ErrorCode.UNKNOWN, p),
      });
    }
  }

  return {
    ok: true,
    created,
    summary: {
      total: args.paths.length,
      succeeded: created.length,
      failed: failures.length,
    },
    ...(failures.length > 0 ? { failures } : {}),
  };
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
    const succeeded = structured.summary.succeeded;
    const failed = structured.summary.failed;
    const label = succeeded === 1 ? 'directory' : 'directories';
    const text =
      failed > 0
        ? `Created ${succeeded} ${label}, ${failed} failed`
        : `Created ${succeeded} ${label}`;
    return buildToolResponse(text, structured);
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
      return `${CREATE_DIRECTORY_TOOL.title}: ${name}`;
    }
    if (result.isError)
      return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories • ${result.errorCode}`;
    return `${CREATE_DIRECTORY_TOOL.title}: ${args.paths.length} directories`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
