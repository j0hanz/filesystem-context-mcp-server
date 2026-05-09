import { basename } from 'node:path';

import { z } from 'zod/v4';

import { NonNegInt, PositiveInt, RequiredPath, Sha256Hex } from '../schemas/fields.js';
import {
  ContinuationSchema,
  createReadRangeFields,
  defaultFalseBoolean,
  validateReadRange,
} from '../schemas/shared.js';

import { ErrorCode } from '../core/errors.js';
import { calculateFileContentHash, detectMimeType, readFile } from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  assignDefined,
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
} from '../core/util.js';
import { defineTool } from './define.js';
import { buildResourceResponse, buildToolResponse, formatBytes, putResource } from './shared.js';

const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

const ReadFileInputSchema = z
  .strictObject({
    path: RequiredPath,
    includeHash: defaultFalseBoolean('Include SHA-256 hash of the content'),
    ...readRangeFields,
    offset: z
      .uint32()
      .optional()
      .describe('Byte offset to start reading (mutually exclusive with line params)'),
    length: z
      .uint32()
      .min(1)
      .optional()
      .describe('Number of bytes to read (used with offset; reads to EOF if omitted)'),
  })
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
        offset: value.offset,
        length: value.length,
      },
      ctx,
    );
  });

const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).default(true).describe('Always true for successful read'),
  path: RequiredPath.describe('Resolved absolute path to the file'),
  content: z.string().optional().describe('File content'),
  mimeType: z
    .string()
    .optional()
    .describe('MIME type of the file (e.g., text/plain, text/x-typescript)'),
  kind: z
    .enum(['text', 'binary', 'image', 'audio', 'pdf'])
    .optional()
    .describe('File kind: text, binary, image, audio, or pdf'),
  resourceUri: z.string().optional().describe('Full content URI in resource store'),
  continuation: ContinuationSchema.optional().describe(
    'Present when file was cut; call the named tool with the given args to read next chunk',
  ),
  totalLines: NonNegInt.optional().describe('Total lines in file'),
  linesRead: NonNegInt.optional().describe('Lines returned'),
  hasMoreLines: z.boolean().optional().describe('More lines available'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: Sha256Hex.optional().describe('SHA-256 of content (when includeHash)'),
  // Byte-range fields
  offset: NonNegInt.optional().describe('Byte offset used'),
  bytesRead: NonNegInt.optional().describe('Bytes returned'),
  reachedEOF: z.boolean().optional().describe('Read reached end of file'),
});

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;
type ReadFileHandlerResult = Awaited<ReturnType<typeof readFile>>;

const READ_TOOL_LABEL = 'Read File';

function buildReadOptions(
  args: ReadFileInput,
  signal?: AbortSignal,
): Parameters<typeof readFile>[1] {
  const options: Parameters<typeof readFile>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
  };

  return assignDefined(options, {
    signal,
    head: args.head,
    tail: args.tail,
    startLine: args.startLine,
    endLine: args.endLine,
    offset: args.offset,
    length: args.length,
  });
}

function buildReadContinuation(result: {
  path: string;
  hasMoreLines?: boolean;
  linesRead?: number;
  startLine?: number;
  endLine?: number;
  head?: number;
  totalLines?: number;
}): z.infer<typeof ContinuationSchema> | undefined {
  if (!result.hasMoreLines) return undefined;
  const linesRead = result.linesRead ?? 0;
  const nextStart = (result.startLine ?? 1) + linesRead;
  let chunkSize: number;
  if (result.head !== undefined) {
    chunkSize = result.head;
  } else if (result.startLine !== undefined && result.endLine !== undefined) {
    chunkSize = result.endLine - result.startLine + 1;
  } else {
    chunkSize = DEFAULT_CONTINUATION_CHUNK_SIZE;
  }
  const nextEnd = nextStart + chunkSize - 1;
  const hint = result.totalLines
    ? `${result.totalLines - nextStart + 1} lines remain (${nextStart}–${result.totalLines}). Read next chunk with these args.`
    : 'File was truncated. Read next chunk with these args.';
  return {
    tool: 'read',
    args: { path: result.path, startLine: nextStart, endLine: nextEnd },
    hint,
  };
}

function toStructuredReadFileResult(
  filePath: string,
  result: ReadFileHandlerResult,
  mimeType: string,
  kind: string,
): ReadFileOutput {
  const structured: ReadFileOutput = {
    ok: true,
    path: filePath,
    content: result.content,
    mimeType,
    kind: kind as 'text' | 'binary' | 'image' | 'audio' | 'pdf',
  };

  return assignDefined(structured, {
    continuation: buildReadContinuation(result),
    totalLines: result.totalLines,
    head: result.head,
    tail: result.tail,
    startLine: result.startLine,
    endLine: result.endLine,
    linesRead: result.linesRead,
    hasMoreLines: result.hasMoreLines ? true : undefined,
    offset: result.offset,
    bytesRead: result.bytesRead,
    reachedEOF: result.reachedEOF,
  });
}

function buildReadProgressLabel(args: ReadFileInput): string {
  const name = basename(args.path);
  if (args.offset !== undefined) {
    const end = args.length !== undefined ? args.offset + args.length - 1 : '…';
    return `${READ_TOOL_LABEL}: ${name} [bytes ${args.offset}–${String(end)}]`;
  }
  if (args.startLine !== undefined) {
    const end = args.endLine ?? '…';
    return `${READ_TOOL_LABEL}: ${name} [lines ${args.startLine}–${end}]`;
  }
  if (args.head !== undefined) return `${READ_TOOL_LABEL}: ${name} [head ${args.head}]`;
  if (args.tail !== undefined) return `${READ_TOOL_LABEL}: ${name} [tail ${args.tail}]`;
  return `${READ_TOOL_LABEL}: ${name}`;
}

async function handleReadFile(
  args: ReadFileInput,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ResourceStore,
): Promise<ReadFileOutput | ReturnType<typeof buildResourceResponse<ReadFileOutput>>> {
  const options = buildReadOptions(args, signal);
  const result = await readFile(args.path, options, pathGuard);
  const mimeInfo = detectMimeType(result.path, Buffer.from(result.content.slice(0, 512)));
  const structured = toStructuredReadFileResult(
    result.path,
    result,
    mimeInfo.mimeType,
    mimeInfo.kind,
  );

  if (args.includeHash) {
    structured.contentHash = await calculateFileContentHash(result.path, signal);
  }

  // Always store content in resource store and return summary + link
  if (resourceStore) {
    const { entry, link } = putResource({
      store: resourceStore,
      name: basename(result.path),
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      content: result.content,
    });

    const structuredWithResource: ReadFileOutput = {
      ...structured,
      resourceUri: entry.uri,
    };

    const summary = [
      `read: ${basename(result.path)}`,
      `${String(structured.totalLines ?? 0)} lines`,
      formatBytes(entry.size),
      mimeInfo.mimeType,
    ].join(' \u00b7 ');

    return buildResourceResponse({
      summary,
      resources: [link],
      structured: structuredWithResource,
    });
  }

  return buildToolResponse(result.content, structured);
}

export const READ_FILE = defineTool({
  name: 'read',
  title: 'Read File',
  description:
    'Read a text file. Use head/tail/startLine/endLine for partial line reads; use offset/length for byte-range reads; use read_many for batches.',
  input: ReadFileInputSchema,
  output: ReadFileOutputSchema,
  annotations: 'readOnly',
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: [
    'Large content is externalized to `filesystem-mcp://result/{id}` and preview is returned inline.',
  ],
  defaultErrorCode: ErrorCode.NOT_FILE,
  progressLabel: buildReadProgressLabel,
  inputSchemaAugment: (schema) => ({
    ...schema,
    allOf: [
      { not: { required: ['head', 'tail'] } },
      { not: { required: ['head', 'startLine'] } },
      { not: { required: ['head', 'endLine'] } },
      { not: { required: ['tail', 'startLine'] } },
      { not: { required: ['tail', 'endLine'] } },
      { not: { required: ['offset', 'head'] } },
      { not: { required: ['offset', 'tail'] } },
      { not: { required: ['offset', 'startLine'] } },
      { not: { required: ['offset', 'endLine'] } },
    ],
  }),
  run: (args, ctx) => handleReadFile(args, ctx.pathGuard, ctx.signal, ctx.resourceStore),
});
