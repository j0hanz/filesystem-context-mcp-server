import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { z } from 'zod/v4';

import { withAbort } from '../core/abort.js';
import { atomicWriteFile } from '../core/atomic-write.js';
import { MAX_TEXT_FILE_SIZE } from '../core/constants.js';
import { ErrorCode } from '../core/errors.js';
import { Logger } from '../core/logger.js';
import { detectMimeType } from '../core/mime.js';
import { NonNegInt, RequiredPath } from '../schemas/fields.js';

import { formatBytes } from '../config.js';
import { buildPathMessages, defineTool } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildResourceResponse,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  putResource,
  type ToolContract,
} from './shared.js';

const WriteFileInputSchema = z.strictObject({
  path: RequiredPath.describe('Target file path'),
  content: z.string().max(MAX_TEXT_FILE_SIZE).describe('File content to write'),
});

const WriteFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Written file path'),
  size: NonNegInt.describe('File size in bytes'),
  lineCount: NonNegInt.describe('Number of lines in file'),
  mimeType: z.string().describe('MIME type of the file'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).describe('File kind'),
  resourceUri: z.string().describe('Full content URI in resource store'),
  created: z.string().describe('Creation timestamp (ISO 8601)'),
  modified: z.string().describe('Last modification timestamp (ISO 8601)'),
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

const writeMessages = buildPathMessages<WriteInput, WriteOutput>(WRITE_FILE_TOOL.title, (sc) =>
  formatBytes(sc.size),
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

    void ctx.log?.('info', `write: ${args.path} (${String(bytesWritten)} bytes)`, 'write');

    // Get file stats and MIME type
    const fileStats = await withAbort(stat(validPath), ctx.signal);
    const mimeInfo = detectMimeType(validPath, Buffer.from(args.content.slice(0, 512)));

    // Count lines in content
    const lineCount = args.content.split('\n').length;

    // Return basic response if no resource store
    if (!ctx.resourceStore) {
      return buildToolResponse(`Successfully wrote to file: ${args.path}`, {
        ok: true,
        path: validPath,
        size: bytesWritten,
        lineCount,
        mimeType: mimeInfo.mimeType,
        kind: mimeInfo.kind,
        resourceUri: '',
        created: fileStats.birthtime.toISOString(),
        modified: fileStats.mtime.toISOString(),
      });
    }

    // Store content in resource store
    const { entry, link } = putResource({
      store: ctx.resourceStore,
      name: basename(validPath),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: args.content,
    });

    // Build summary message
    const summary = [
      `write: ${basename(validPath)}`,
      formatBytes(bytesWritten),
      `${lineCount} lines`,
    ].join(' · ');

    // Build structured response
    const structured: WriteOutput = {
      ok: true,
      path: validPath,
      size: bytesWritten,
      lineCount,
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      resourceUri: entry.uri,
      created: fileStats.birthtime.toISOString(),
      modified: fileStats.mtime.toISOString(),
    };

    return buildResourceResponse({
      summary,
      resources: [link],
      structured,
    });
  },
  ...writeMessages,
  defaultErrorCode: ErrorCode.UNKNOWN,
});
