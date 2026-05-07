import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { ErrorCode } from '../lib/errors.js';
import { atomicWriteFile } from '../lib/fs-helpers.js';
import { Logger } from '../lib/logger.js';
import { validatePathForWrite } from '../lib/paths.js';
import { WriteFileInputSchema } from '../schemas/inputs.js';
import { WriteFileOutputSchema } from '../schemas/outputs.js';

import { formatBytes } from '../config.js';
import { defineTool, type ToolRunContext } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const WRITE_FILE_TOOL: ToolContract = {
  name: 'write',
  title: 'Write File',
  description:
    'Write content to a file, OVERWRITING ALL existing content. Creates the file and parent directories if needed.',
  inputSchema: WriteFileInputSchema,
  outputSchema: WriteFileOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_EDIT_ICONS,
  taskSupport: 'forbidden',
} as const;

export const WRITE_FILE = defineTool<
  z.infer<typeof WriteFileInputSchema>,
  z.infer<typeof WriteFileOutputSchema>
>({
  contract: WRITE_FILE_TOOL,
  run: async (args, ctx: ToolRunContext) => {
    const validPath = await validatePathForWrite(args.path, ctx.signal);

    // Ensure parent directory exists
    await withAbort(mkdir(dirname(validPath), { recursive: true }), ctx.signal);

    await atomicWriteFile(validPath, args.content, {
      encoding: 'utf-8',
      signal: ctx.signal,
    });

    const bytesWritten = Buffer.byteLength(args.content, 'utf-8');

    Logger.info(`write: ${args.path} (${bytesWritten} bytes)`);

    void ctx.log?.(
      'info',
      `write: ${args.path} (${String(bytesWritten)} bytes)`,
      'write'
    );

    return buildToolResponse(`Successfully wrote to file: ${args.path}`, {
      ok: true,
      path: validPath,
      bytesWritten,
    });
  },
  progressMessage: (args) => `${WRITE_FILE_TOOL.title}: ${basename(args.path)}`,
  completionMessage: (args, result) => {
    const name = basename(args.path);
    if (result.isError)
      return `${WRITE_FILE_TOOL.title}: ${name} • ${result.errorCode}`;
    const sc = result.structuredContent;
    return `${WRITE_FILE_TOOL.title}: ${name} • ${formatBytes(sc.bytesWritten)}`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
