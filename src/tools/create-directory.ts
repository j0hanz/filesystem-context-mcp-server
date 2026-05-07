import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';

import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode } from '../lib/errors.js';
import { validatePathForWrite } from '../lib/paths.js';
import { CreateDirectoryInputSchema } from '../schemas/inputs.js';
import { CreateDirectoryOutputSchema } from '../schemas/outputs.js';

import { defineTool } from './define-tool.js';
import { DIR_CREATE_ICONS } from './icons.js';
import {
  buildToolResponse,
  IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const CREATE_DIRECTORY_TOOL: ToolContract = {
  name: 'mkdir',
  title: 'Create Directory',
  description: 'Create a new directory at the specified path (recursive).',
  inputSchema: CreateDirectoryInputSchema,
  outputSchema: CreateDirectoryOutputSchema,
  annotations: IDEMPOTENT_WRITE_TOOL_ANNOTATIONS,
  icons: DIR_CREATE_ICONS,
  taskSupport: 'forbidden',
} as const;

async function handleCreateDirectory(
  args: z.infer<typeof CreateDirectoryInputSchema>,
  signal?: AbortSignal
): Promise<z.infer<typeof CreateDirectoryOutputSchema>> {
  const validPaths = await Promise.all(
    args.paths.map((p) => validatePathForWrite(p, signal))
  );

  const results = await Promise.all(
    validPaths.map(async (p) => {
      const isNew = await withAbort(mkdir(p, { recursive: true }), signal)
        .then((created) => created !== undefined)
        .catch(() => false);
      return { path: p, isNew };
    })
  );

  const succeeded = results.length;

  return {
    ok: true,
    created: results,
    summary: { total: results.length, succeeded, failed: 0 },
  };
}

export const CREATE_DIRECTORY = defineTool<
  z.infer<typeof CreateDirectoryInputSchema>,
  z.infer<typeof CreateDirectoryOutputSchema>
>({
  contract: CREATE_DIRECTORY_TOOL,
  run: async (args, ctx) => {
    const structured = await handleCreateDirectory(args, ctx.signal);
    const succeeded = structured.summary.succeeded;
    const label = succeeded === 1 ? 'directory' : 'directories';
    const text = `Created ${succeeded} ${label}`;
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
