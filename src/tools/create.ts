import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, isAbortError, Problem } from '../core/errors.js';
import { formatBytes } from '../core/fmt.js';
import { countLines } from '../core/fs.js';
import { detectMimeType, MIME_SAMPLE_SIZE } from '../core/mime.js';
import { MAX_TEXT_FILE_SIZE } from '../core/util.js';
import { FileKind, IsoDateTime, NonNegInt, PerFileErrorSchema, RequiredPath } from '../schema.js';
import { buildFileResourceLink, buildFileResourceUri } from './_helpers.js';
import { defineTool } from './define.js';

const CreateFileItemSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path where the file will be created'),
  content: z
    .string()
    .max(MAX_TEXT_FILE_SIZE)
    .describe(
      'Text content to write. Overwrites any existing file at this path. Cannot contain shell commands or malicious injection sequences.',
    ),
});

const CreateFileResultSchema = z.strictObject({
  ok: z
    .literal(true)
    .describe('Always true; per-file failures are reported in the outer failures array'),
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

const CreateFailureItemSchema = z.strictObject({
  path: z.string(),
  error: PerFileErrorSchema,
});

type CreateFailureItem = z.infer<typeof CreateFailureItemSchema>;

const CreateOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-file errors are in failures[]'),
  files: z.array(CreateFileResultSchema).describe('Successfully created files'),
  failures: z
    .array(CreateFailureItemSchema)
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
  const parts = [`create: ${String(results.length)} file${results.length === 1 ? '' : 's'}`];
  if (failCount > 0) parts.push(`${String(failCount)} failed`);
  return parts.join(' \u00b7 ');
}

export const CREATE = defineTool({
  name: 'create',
  title: 'Create Files',
  description:
    'Create one or more files (max 100), writing or overwriting content and creating parent directories as needed. ' +
    'Silently overwrites existing files — read first if you need to preserve existing content.',
  input: CreateInputSchema,
  output: CreateOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  run: async (args, ctx) => {
    const results: CreateFileResult[] = [];
    const links: ContentBlock[] = [];
    const failures: CreateFailureItem[] = [];

    for (const file of args.files) {
      try {
        await withAbort(ctx.fs.mkdir(dirname(file.path), { recursive: true }), ctx.signal);

        const { validPath } = await ctx.fs.writeFile(file.path, file.content, {
          encoding: 'utf-8',
          signal: ctx.signal,
        });

        const { stats: fileStats } = await ctx.fs.stat(file.path, { signal: ctx.signal });
        const bytesWritten = Buffer.byteLength(file.content, 'utf-8');
        const lineCount = countLines(file.content);
        const mimeInfo = detectMimeType(
          validPath,
          Buffer.from(file.content.slice(0, MIME_SAMPLE_SIZE)),
        );

        const resourceUri = buildFileResourceUri(validPath);
        if (ctx.resourceStore) {
          links.push(buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten));
        }

        results.push({
          ok: true as const,
          path: validPath,
          size: bytesWritten,
          lineCount,
          mimeType: mimeInfo.mimeType,
          kind: mimeInfo.kind,
          resourceUri,
          created: fileStats.birthtime.toISOString(),
          modified: fileStats.mtime.toISOString(),
        });
      } catch (err) {
        if (isAbortError(err)) throw err; // propagate cancellation
        failures.push({
          path: file.path,
          error: Problem.fromUnknown(err, ErrorCode.UNKNOWN, file.path),
        });
      }
    }

    const structured = {
      ok: true as const,
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
