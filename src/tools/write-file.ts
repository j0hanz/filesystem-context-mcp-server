import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { z } from 'zod/v4';

import { NonNegInt, RequiredPath } from '../schemas/fields.js';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode } from '../core/errors.js';
import { atomicWriteFile, detectMimeType } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import { MAX_TEXT_FILE_SIZE } from '../core/util.js';
import { defineTool } from './define.js';
import { putResource } from './shared.js';

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

export const WRITE_FILE = defineTool({
  name: 'write',
  title: 'Write File',
  description:
    'Write content to a file, OVERWRITING ALL existing content. Creates the file and parent directories if needed.',
  input: WriteFileInputSchema,
  output: WriteFileOutputSchema,
  annotations: 'destructiveWrite',
  gotchas: [
    'Overwrites silently — read existing content first if you need to merge.',
    'Use `edit` for partial changes.',
  ],
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

    ctx.log?.('info', `write: ${args.path} (${String(bytesWritten)} bytes)`, 'write');

    // Get file stats and MIME type
    const fileStats = await withAbort(stat(validPath), ctx.signal);
    const mimeInfo = detectMimeType(validPath, Buffer.from(args.content.slice(0, 512)));

    // Count lines in content
    const lineCount = args.content.split('\n').length;

    // Return basic response if no resource store
    if (!ctx.resourceStore) {
      return {
        ok: true as const,
        path: validPath,
        size: bytesWritten,
        lineCount,
        mimeType: mimeInfo.mimeType,
        kind: mimeInfo.kind,
        resourceUri: '',
        created: fileStats.birthtime.toISOString(),
        modified: fileStats.mtime.toISOString(),
      };
    }

    // Store content in resource store
    const { entry } = putResource({
      store: ctx.resourceStore,
      name: basename(validPath),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: args.content,
    });

    return {
      ok: true as const,
      path: validPath,
      size: bytesWritten,
      lineCount,
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      resourceUri: entry.uri,
      created: fileStats.birthtime.toISOString(),
      modified: fileStats.mtime.toISOString(),
    };
  },
  progressLabel: (args) => `Write File: ${basename(args.path)}`,
  defaultErrorCode: ErrorCode.UNKNOWN,
});
