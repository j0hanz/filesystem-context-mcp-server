import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../lib/abort.js';
import { atomicWriteFile } from '../lib/atomic-write.js';
import { MAX_TEXT_FILE_SIZE } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { Logger } from '../lib/logger.js';
import { NonNegInt, RequiredPath } from '../schemas/fields.js';

import { formatBytes } from '../config.js';
import { buildPathMessages, defineTool } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const WriteFileInputSchema = z.strictObject({
  path: RequiredPath.describe('Target file path'),
  content: z.string().max(MAX_TEXT_FILE_SIZE).describe('File content to write'),
});

const WriteFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Written file path'),
  bytesWritten: NonNegInt.describe('Bytes written'),
});

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
  run: async (args, ctx) => {
    const validPath = await ctx.pathGuard.validatePathForWrite(args.path);

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
