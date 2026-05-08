import { basename } from 'node:path';

import { z } from 'zod/v4';

import {
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import { calculateFileContentHash, readFile } from '../lib/file-content.js';
import { assignDefined } from '../lib/utils.js';
import {
  NonNegInt,
  PositiveInt,
  RequiredPath,
  Sha256Hex,
} from '../schemas/fields.js';
import {
  readRangeConstraints,
  toToolJsonSchema,
} from '../schemas/json-schema.js';
import {
  ContinuationSchema,
  createReadRangeFields,
  defaultFalseBoolean,
  validateReadRange,
} from '../schemas/shared.js';

import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildResourceLink,
  buildToolResponse,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResponse,
  type ToolResult,
} from './shared.js';

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
      .describe(
        'Byte offset to start reading (mutually exclusive with line params)'
      ),
    length: z
      .uint32()
      .min(1)
      .optional()
      .describe(
        'Number of bytes to read (used with offset; reads to EOF if omitted)'
      ),
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
      ctx
    );
  });

const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Resolved path'),
  content: z.string().optional().describe('File content'),
  resourceUri: z
    .string()
    .optional()
    .describe('Full content URI when externalized'),
  continuation: ContinuationSchema.optional().describe(
    'Present when file was cut; call the named tool with the given args to read next chunk'
  ),
  totalLines: NonNegInt.optional().describe('Total lines in file'),
  linesRead: NonNegInt.optional().describe('Lines returned'),
  hasMoreLines: z.boolean().optional().describe('More lines available'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: Sha256Hex.optional().describe(
    'SHA-256 of content (when includeHash)'
  ),
  // Byte-range fields
  offset: NonNegInt.optional().describe('Byte offset used'),
  bytesRead: NonNegInt.optional().describe('Bytes returned'),
  reachedEOF: z.boolean().optional().describe('Read reached end of file'),
});

const READ_FILE_TOOL: ToolContract = {
  name: 'read',
  title: 'Read File',
  description:
    'Read a text file. Use head/tail/startLine/endLine for partial line reads; use offset/length for byte-range reads; use read_many for batches.',
  inputSchema: ReadFileInputSchema,
  inputSchemaJson: toToolJsonSchema(ReadFileInputSchema, (s) => ({
    ...s,
    allOf: [
      ...(Array.isArray(s.allOf) ? (s.allOf as unknown[]) : []),
      ...readRangeConstraints(),
    ],
  })),
  outputSchema: ReadFileOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  nuances: [
    'Large content is externalized to `filesystem-mcp://result/{id}` and preview is returned inline.',
  ],
  taskSupport: 'forbidden',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;
type ReadFileHandlerResult = Awaited<ReturnType<typeof readFile>>;

const READ_TOOL_LABEL = READ_FILE_TOOL.title;
const FULL_FILE_CONTENTS_DESCRIPTION = 'Full file contents';

function buildReadResourceName(filePath: string): string {
  return `read:${basename(filePath)}`;
}

function buildReadOptions(
  args: ReadFileInput,
  signal?: AbortSignal
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
  result: ReadFileHandlerResult
): ReadFileOutput {
  const structured: ReadFileOutput = {
    ok: true,
    path: result.path,
    content: result.content,
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

function maybeBuildExternalizedReadResponse(
  filePath: string,
  content: string,
  structured: ReadFileOutput,
  resourceStore?: Parameters<typeof maybeExternalizeTextContent>[0]
): ToolResponse<ReadFileOutput> | undefined {
  const externalized = maybeExternalizeTextContent(resourceStore, content, {
    name: buildReadResourceName(filePath),
    mimeType: 'text/plain',
  });
  if (!externalized) {
    return undefined;
  }

  const { entry, preview } = externalized;
  const structuredWithResource: ReadFileOutput = {
    ...structured,
    content: preview,
    resourceUri: entry.uri,
  };

  const text = [
    `Output too large to inline (${content.length} chars).`,
    'Preview:',
    preview,
  ].join('\n');

  return buildToolResponse(text, structuredWithResource, [
    buildResourceLink({
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      description: FULL_FILE_CONTENTS_DESCRIPTION,
      expiresAt: entry.expiresAt,
    }),
  ]);
}

function buildReadProgressMessage(args: ReadFileInput): string {
  const name = basename(args.path);
  if (args.offset !== undefined) {
    const end = args.length !== undefined ? args.offset + args.length - 1 : '…';
    return `${READ_TOOL_LABEL}: ${name} [bytes ${args.offset}–${String(end)}]`;
  }
  if (args.startLine !== undefined) {
    const end = args.endLine ?? '…';
    return `${READ_TOOL_LABEL}: ${name} [lines ${args.startLine}–${end}]`;
  }
  if (args.head !== undefined)
    return `${READ_TOOL_LABEL}: ${name} [head ${args.head}]`;
  if (args.tail !== undefined)
    return `${READ_TOOL_LABEL}: ${name} [tail ${args.tail}]`;
  return `${READ_TOOL_LABEL}: ${name}`;
}

function buildReadCompletionMessage(
  args: ReadFileInput,
  result: ToolResult<ReadFileOutput>
): string {
  const name = basename(args.path);
  if (result.isError)
    return `${READ_TOOL_LABEL}: ${name} • ${result.errorCode}`;

  const structured = result.structuredContent;

  if (structured.offset !== undefined) {
    return `${READ_TOOL_LABEL}: ${name} • ${String(structured.bytesRead ?? 0)} bytes @ ${String(structured.offset)}`;
  }

  const lines = structured.linesRead ?? structured.totalLines;

  if (structured.startLine !== undefined) {
    const end = structured.linesRead
      ? structured.startLine + structured.linesRead - 1
      : (structured.endLine ?? '…');
    return `${READ_TOOL_LABEL}: ${name} • lines ${structured.startLine}–${end}`;
  }

  if (structured.head !== undefined) {
    return structured.hasMoreLines
      ? `${READ_TOOL_LABEL}: ${name} • first ${String(lines ?? structured.head)} lines`
      : `${READ_TOOL_LABEL}: ${name} • ${String(lines ?? structured.head)} lines`;
  }

  if (structured.tail !== undefined) {
    return structured.hasMoreLines
      ? `${READ_TOOL_LABEL}: ${name} • last ${String(lines ?? structured.tail)} lines`
      : `${READ_TOOL_LABEL}: ${name} • ${String(lines ?? structured.tail)} lines`;
  }

  if (structured.continuation) {
    return `${READ_TOOL_LABEL}: ${name} • truncated [${String(lines)} lines]`;
  }

  return `${READ_TOOL_LABEL}: ${name} • ${String(lines)} lines`;
}

async function handleReadFile(
  args: ReadFileInput,
  signal?: AbortSignal,
  resourceStore?: Parameters<typeof maybeExternalizeTextContent>[0]
): Promise<ToolResponse<ReadFileOutput>> {
  const options = buildReadOptions(args, signal);
  const result = await readFile(args.path, options);
  const structured = toStructuredReadFileResult(result);

  if (args.includeHash) {
    structured.contentHash = await calculateFileContentHash(
      result.path,
      signal
    );
  }

  const externalizedResponse = maybeBuildExternalizedReadResponse(
    args.path,
    result.content,
    structured,
    resourceStore
  );
  if (externalizedResponse) {
    return externalizedResponse;
  }

  return buildToolResponse(result.content, structured);
}

export const READ_FILE = defineTool<ReadFileInput, ReadFileOutput>({
  contract: READ_FILE_TOOL,
  defaultErrorCode: ErrorCode.NOT_FILE,
  run: (args, ctx) => handleReadFile(args, ctx.signal, ctx.resourceStore),
  progressMessage: buildReadProgressMessage,
  completionMessage: buildReadCompletionMessage,
});
