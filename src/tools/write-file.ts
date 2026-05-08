import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { ErrorCode } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { validatePathForWrite } from '../lib/paths.js';
import { WriteFileInputSchema } from '../schemas/inputs.js';
import { WriteFileOutputSchema } from '../schemas/outputs.js';

import { formatBytes } from '../config.js';
import {
  buildPathMessages,
  defineTool,
  type ToolRunContext,
} from './define-tool.js';
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
  gotchas: [
    'Overwrites silently — read existing content first if you need to merge.',
    'Use `edit` for partial changes.',
  ],
  taskSupport: 'forbidden',
} as const;

type WriteInput = z.infer<typeof WriteFileInputSchema>;
type WriteOutput = z.infer<typeof WriteFileOutputSchema>;

const writeMessages = buildPathMessages<WriteInput, WriteOutput>(
  WRITE_FILE_TOOL.title,
  (sc) => formatBytes(sc.bytesWritten)
);

export const WRITE_FILE = defineTool<WriteInput, WriteOutput>({
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
  ...writeMessages,
  defaultErrorCode: ErrorCode.UNKNOWN,
});
