import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { buildFileResourceLink, buildFileResourceUri } from '../core/file-uri.js';
import { formatBytes, joinRoster } from '../core/fmt.js';
import { detectMimeFromContent } from '../core/mime.js';
import { countLines } from '../core/read.js';
import {
  FileKind,
  IsoDateTime,
  NonNegInt,
  PathFailureSchema,
  RequiredPath,
} from '../core/schema.js';
import { getMaxTextFileSize } from '../core/util.js';
import { runOverPaths } from './batch.js';
import { defineTool } from './define.js';

const CreateFileItemSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path where the file will be created'),
  content: z
    .string()
    .refine((val) => val.length <= getMaxTextFileSize(), {
      message: 'Content exceeds maximum allowed text file size',
    })
    .describe('Text content to write, verbatim.'),
});

const CreateFileResultSchema = z.strictObject({
  path: z.string().describe('Resolved absolute path of the created file'),
  size: NonNegInt.describe('File size in bytes after writing'),
  lineCount: NonNegInt.describe('Number of lines in the written file'),
  mimeType: z.string().describe('Detected MIME type of the file'),
  kind: FileKind.describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z
    .string()
    .describe('Resource URI pointing to the created file content in the resource store'),
  created: IsoDateTime.describe('File creation timestamp (ISO 8601 UTC)'),
  modified: IsoDateTime.describe('File last-modification timestamp (ISO 8601 UTC)'),
});

const CreateInputSchema = z.strictObject({
  files: z
    .array(CreateFileItemSchema)
    .min(1)
    .max(100)
    .describe('List of files to create (max 100); each entry requires path and content'),
});

type CreateFailureItem = z.infer<typeof PathFailureSchema>;

const CreateOutputSchema = z.strictObject({
  files: z.array(CreateFileResultSchema).describe('Successfully created files'),
  failures: z
    .array(PathFailureSchema)
    .optional()
    .describe('Files that failed to create with per-file error details'),
});

type CreateFileResult = z.infer<typeof CreateFileResultSchema>;

function buildSummary(results: readonly CreateFileResult[], failCount: number): string {
  if (results.length === 1 && failCount === 0) {
    const result = results[0];
    if (result) {
      return [
        `create: ${basename(result.path)}`,
        formatBytes(result.size),
        `${String(result.lineCount)} lines`,
      ].join(' \u00b7 ');
    }
  }
  // Name what was written. "create: 3 files" made the caller open
  // structuredContent to learn which three \u2014 every other write tool answers
  // with its roster.
  const names = joinRoster(results.map((r) => basename(r.path)));
  const parts = [`create: ${names || 'nothing'}`];
  if (failCount > 0) parts.push(`${String(failCount)} failed`);
  return parts.join(' \u00b7 ');
}

export const CREATE = defineTool({
  name: 'create',
  title: 'Create Files',
  description:
    'Create one or more files (max 100), writing or overwriting content and creating parent directories as needed. ' +
    'Pass files: [{ path, content }] — there is no single-path form. ' +
    'Silently overwrites existing files — read first if you need to preserve existing content.',
  input: CreateInputSchema,
  output: CreateOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  accessPaths: (args) => args.files.map((f) => f.path),
  run: async (args, ctx) => {
    const batch = await runOverPaths<
      { content: string },
      { file: CreateFileResult; resourceLink?: ContentBlock }
    >(
      { files: args.files },
      ctx,
      async ({ path, override }) => {
        const content = override?.content ?? '';

        await ctx.fs.mkdir(dirname(path), { recursive: true });

        const { validPath } = await ctx.fs.writeFile(path, content, {
          encoding: 'utf-8',
          signal: ctx.signal,
        });

        const { stats: fileStats } = await ctx.fs.stat(path, { signal: ctx.signal });
        const bytesWritten = Buffer.byteLength(content, 'utf-8');
        const lineCount = countLines(content);
        const mimeInfo = detectMimeFromContent(validPath, content);

        const resourceUri = buildFileResourceUri(validPath);
        const file: CreateFileResult = {
          path: validPath,
          size: bytesWritten,
          lineCount,
          mimeType: mimeInfo.mimeType,
          kind: mimeInfo.kind,
          resourceUri,
          created: fileStats.birthtime.toISOString(),
          modified: fileStats.mtime.toISOString(),
        };

        return ctx.resourceStore
          ? {
              file,
              resourceLink: buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten),
            }
          : { file };
      },
      { defaultErrorCode: ErrorCode.UNKNOWN },
    );

    const results: CreateFileResult[] = [];
    const failures: CreateFailureItem[] = [];
    const links: ContentBlock[] = [];
    for (const r of batch.results) {
      if ('error' in r) {
        failures.push({ path: r.path, error: r.error });
        continue;
      }
      results.push(r.value.file);
      if (r.value.resourceLink) links.push(r.value.resourceLink);
    }

    const structured = {
      files: results,
      ...(failures.length > 0 ? { failures } : {}),
    };
    const summary = buildSummary(results, failures.length);

    if (links.length > 0) {
      return { structured, text: summary, resources: links };
    }

    return { structured, text: summary };
  },
  progress: (args) => ({
    label: 'Create',
    subject:
      args.files.length === 1
        ? basename(args.files[0]?.path ?? '')
        : `${String(args.files.length)} files`,
  }),
  defaultErrorCode: ErrorCode.UNKNOWN,
});
