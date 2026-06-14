import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename, dirname } from 'node:path';

import * as z from 'zod/v4';

import { withAbort } from '../core/concurrency.js';
import { ErrorCode, isAbortError, Problem } from '../core/errors.js';
import { formatBytes } from '../core/fmt.js';
import { atomicWriteFile, detectMimeType, MIME_SAMPLE_SIZE, mkdir, stat } from '../core/fs.js';
import { MAX_TEXT_FILE_SIZE } from '../core/util.js';
import { FileKind, IsoDateTime, NonNegInt, PerFileErrorSchema, RequiredPath } from '../schema.js';
import { defineTool } from './define.js';

const CreateFileItemSchema = z.strictObject({
  path: RequiredPath.describe('Target file path'),
  content: z.string().max(MAX_TEXT_FILE_SIZE).describe('File content to write'),
});

const CreateFileResultSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Written file path'),
  size: NonNegInt.describe('File size in bytes'),
  lineCount: NonNegInt.describe('Number of lines in file'),
  mimeType: z.string().describe('MIME type of the file'),
  kind: FileKind.describe('File kind'),
  resourceUri: z.string().describe('Full content URI in resource store'),
  created: IsoDateTime.describe('Creation timestamp (ISO 8601 UTC)'),
  modified: IsoDateTime.describe('Last modification timestamp (ISO 8601 UTC)'),
});

const CreateInputSchema = z.strictObject({
  files: z.array(CreateFileItemSchema).min(1).max(100).describe('Files to create'),
});

const CreateFailureItemSchema = z.strictObject({
  path: z.string(),
  error: PerFileErrorSchema,
});

type CreateFailureItem = z.infer<typeof CreateFailureItemSchema>;

const CreateOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  files: z.array(CreateFileResultSchema).describe('Created files'),
  failures: z.array(CreateFailureItemSchema).optional().describe('Per-file errors'),
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
    'Create one or more files, overwriting existing content and creating parent directories as needed.',
  input: CreateInputSchema,
  output: CreateOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  gotchas: [
    'Overwrites silently - read existing content first if you need to merge.',
    'Use edit for partial changes.',
  ],
  run: async (args, ctx) => {
    const results: CreateFileResult[] = [];
    const links: ContentBlock[] = [];
    const failures: CreateFailureItem[] = [];

    for (const file of args.files) {
      try {
        await withAbort(mkdir(dirname(file.path), ctx.pathGuard, { recursive: true }), ctx.signal);

        const { validPath } = await atomicWriteFile(file.path, file.content, ctx.pathGuard, {
          encoding: 'utf-8',
          signal: ctx.signal,
        });

        const { stats: fileStats } = await stat(file.path, ctx.pathGuard, { signal: ctx.signal });
        const bytesWritten = Buffer.byteLength(file.content, 'utf-8');
        const lineCount = file.content.split('\n').length;
        const mimeInfo = detectMimeType(
          validPath,
          Buffer.from(file.content.slice(0, MIME_SAMPLE_SIZE)),
        );

        const resourceUri = `filesystem-mcp://file/${validPath.replace(/\\/g, '/')}`;
        if (ctx.resourceStore) {
          const contentSize = Buffer.byteLength(file.content, 'utf-8');
          links.push({
            type: 'resource_link',
            uri: resourceUri,
            name: basename(validPath),
            mimeType: mimeInfo.mimeType,
            size: contentSize,
            annotations: { audience: ['user', 'assistant'] },
          });
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
