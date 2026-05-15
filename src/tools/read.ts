import type { ContentBlock } from '@modelcontextprotocol/server';

import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { processInParallel, withAbort } from '../core/concurrency.js';
import { ErrorCode, Problem } from '../core/errors.js';
import {
  applyIndexedErrors,
  applyIndexedValues,
  calculateFileContentHash,
  detectMimeType,
  MIME_SAMPLE_SIZE,
  readFile,
  readFileWithStats,
} from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  assignDefined,
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import {
  ContinuationSchema,
  createReadRangeFields,
  defaultFalseBoolean,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  RequiredPath,
  Sha256Hex,
  validateReadRange,
} from '../schema.js';
import { formatBytes, putResource } from './_helpers.js';
import { defineTool, type RunResult } from './define.js';

const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

const ReadFileInputSchema = z
  .strictObject({
    path: RequiredPath.optional().describe('File path (single-file mode)'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(1000)
      .optional()
      .describe('File paths (batch mode; max 1000)'),
    includeHash: defaultFalseBoolean('Include SHA-256 hash of the content'),
    ...readRangeFields,
    offset: z
      .uint32()
      .optional()
      .describe(
        'Byte offset to start reading (single-file mode only; mutually exclusive with line params)',
      ),
    length: z
      .uint32()
      .min(1)
      .optional()
      .describe(
        'Number of bytes to read (single-file mode only; used with offset; reads to EOF if omitted)',
      ),
  })
  .superRefine((value, ctx) => {
    const hasPath = value.path !== undefined;
    const hasPaths = value.paths !== undefined;

    // Require exactly one of path or paths
    if (!hasPath && !hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Either 'path' or 'paths' must be provided",
        input: value,
      });
      return;
    }

    if (hasPath && hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: "Cannot use both 'path' and 'paths'",
        input: value,
      });
      return;
    }

    // offset and length are not supported in batch mode
    if (hasPaths && (value.offset !== undefined || value.length !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['offset'],
        message: "'offset' and 'length' are not supported in batch mode",
        input: value,
      });
    }

    // Validate line-based range parameters (applies to both single and batch modes when provided)
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

const ReadManyItemSchema = z.strictObject({
  path: z.string().describe('File path'),
  resourceUri: z.string().optional().describe('Full content URI'),
  mimeType: z.string().optional().describe('MIME type of the file'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).optional().describe('File kind'),
  totalLines: NonNegInt.optional().describe('Total lines'),
  linesRead: NonNegInt.optional().describe('Lines returned'),
  hasMoreLines: z.boolean().optional().describe('More lines available'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  continuation: ContinuationSchema.optional().describe('Present when file was cut'),
  bytesRead: NonNegInt.optional().describe('Bytes returned'),
  error: PerFileErrorSchema.optional().describe('Per-file error'),
});

const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: RequiredPath.optional().describe('Resolved absolute path to the file'),
  content: z.string().optional().describe('File content'),
  mimeType: z.string().optional().describe('MIME type'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).optional().describe('File kind'),
  resourceUri: z.string().optional().describe('Full content URI in resource store'),
  continuation: ContinuationSchema.optional().describe('Present when file was cut'),
  totalLines: NonNegInt.optional().describe('Total lines in file'),
  linesRead: NonNegInt.optional().describe('Lines returned'),
  hasMoreLines: z.boolean().optional().describe('More lines available'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: Sha256Hex.optional().describe('SHA-256 of content (when includeHash)'),
  offset: NonNegInt.optional().describe('Byte offset used'),
  bytesRead: NonNegInt.optional().describe('Bytes returned'),
  reachedEOF: z.boolean().optional().describe('Read reached end of file'),
  // Batch mode fields (present when paths[] was used)
  results: z.array(ReadManyItemSchema).optional().describe('Per-file results (batch mode)'),
  summary: OperationSummarySchema.optional().describe('Operation summary (batch mode)'),
});

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;
type ReadFileHandlerResult = Awaited<ReturnType<typeof readFile>>;

export { ReadFileInputSchema };

const READ_TOOL_LABEL = 'Read';

function buildReadOptions(
  args: ReadFileInput,
  signal?: AbortSignal,
): Parameters<typeof readFile>[1] {
  const options: Parameters<typeof readFile>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
  };

  const head = 'head' in args && typeof args.head === 'number' ? args.head : undefined;
  const tail = 'tail' in args && typeof args.tail === 'number' ? args.tail : undefined;
  const startLine =
    'startLine' in args && typeof args.startLine === 'number' ? args.startLine : undefined;
  const endLine = 'endLine' in args && typeof args.endLine === 'number' ? args.endLine : undefined;
  const offset = 'offset' in args && typeof args.offset === 'number' ? args.offset : undefined;
  const length = 'length' in args && typeof args.length === 'number' ? args.length : undefined;

  return assignDefined(options, {
    signal,
    head,
    tail,
    startLine,
    endLine,
    offset,
    length,
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

async function handleReadFile(
  args: ReadFileInput & { path: string },
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ResourceStore,
): Promise<RunResult<ReadFileOutput>> {
  const options = buildReadOptions(args, signal);
  const result = await readFile(args.path, options, pathGuard);
  const mimeInfo = detectMimeType(
    result.path,
    Buffer.from(result.content.slice(0, MIME_SAMPLE_SIZE)),
  );
  const structured = toStructuredReadFileResult(
    result.path,
    result,
    mimeInfo.mimeType,
    mimeInfo.kind,
  );

  if (args.includeHash) {
    structured.contentHash = await calculateFileContentHash(result.path, signal);
  }

  // Build a filesystem-mcp://file URI pointing to the actual file on disk.
  // This lets the user click to open the real file and never expires.
  if (resourceStore) {
    const fileUri = `filesystem-mcp://file/${result.path.replace(/\\/g, '/')}`;
    const contentSize = Buffer.byteLength(result.content, 'utf-8');

    const link: ContentBlock = {
      type: 'resource_link',
      uri: fileUri,
      name: basename(result.path),
      mimeType: mimeInfo.mimeType,
      size: contentSize,
      annotations: { audience: ['user', 'assistant'] },
    };

    const structuredWithResource: ReadFileOutput = {
      ...structured,
      resourceUri: fileUri,
    };

    const summary = [
      `read: ${basename(result.path)}`,
      `${String(structured.totalLines ?? 0)} lines`,
      formatBytes(contentSize),
      mimeInfo.mimeType,
    ].join(' \u00b7 ');

    return { structured: structuredWithResource, text: summary, resources: [link] };
  }

  return { structured, text: result.content };
}

// ---------------------------------------------------------------------------
// Multi-file (batch) implementation
// ---------------------------------------------------------------------------

const UNKNOWN_PATH = '(unknown)';

interface ReadMultipleResult {
  path: string;
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  readMode?: 'full' | 'head' | 'tail' | 'range' | 'byteRange';
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  error?: Error;
}

interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
}

interface ReadMultipleOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  signal?: AbortSignal;
  onReadComplete?: () => void;
  pathGuard?: PathGuard;
}

interface FileReadTask {
  filePath: string;
  index: number;
  validPath?: string;
  stats?: Stats;
}

interface LineSelectionOptions {
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
}

interface ValidatedFileInfo {
  index: number;
  filePath: string;
  validPath: string;
  stats: Stats;
}

function estimateReadSize(stats: Stats, maxSize: number): number {
  return Math.min(stats.size, maxSize);
}

type InternalReadFileOptions = LineSelectionOptions & {
  encoding: BufferEncoding;
  maxSize: number;
  skipBinary?: boolean;
};

function applyLineSelection(target: LineSelectionOptions, source: LineSelectionOptions): void {
  assignDefined(target, { head: source.head, tail: source.tail });
  if (source.endLine !== undefined) {
    target.startLine = source.startLine ?? 1;
    target.endLine = source.endLine;
  } else if (source.startLine !== undefined) {
    target.startLine = source.startLine;
  }
}

function buildBatchReadOptions(options: NormalizedReadMultipleOptions): InternalReadFileOptions {
  const readOptions: InternalReadFileOptions = {
    encoding: options.encoding,
    maxSize: options.maxSize,
    skipBinary: true,
  };
  applyLineSelection(readOptions, options);
  return readOptions;
}

function buildReadMultipleResult(
  filePath: string,
  result: Awaited<ReturnType<typeof readFile>>,
): ReadMultipleResult {
  const output: ReadMultipleResult = {
    path: filePath,
    content: result.content,
    truncated: result.truncated,
    readMode: result.readMode,
  };
  return assignDefined(output, {
    totalLines: result.totalLines,
    head: result.head,
    tail: result.tail,
    startLine: result.startLine,
    endLine: result.endLine,
    linesRead: result.linesRead,
    hasMoreLines: result.hasMoreLines,
  });
}

async function readSingleFileTask(
  task: FileReadTask,
  readOptions: Parameters<typeof readFile>[1],
  pathGuard: PathGuard,
): Promise<{ index: number; value: ReadMultipleResult }> {
  const { filePath, index, validPath, stats } = task;
  const result =
    validPath && stats
      ? await readFileWithStats(filePath, validPath, stats, readOptions, pathGuard)
      : await readFile(filePath, readOptions, pathGuard);
  return { index, value: buildReadMultipleResult(filePath, result) };
}

async function readFilesInParallel(
  filesToProcess: FileReadTask[],
  options: NormalizedReadMultipleOptions,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  onReadComplete?: () => void,
): Promise<{
  results: { index: number; value: ReadMultipleResult }[];
  errors: { index: number; error: Error }[];
}> {
  const readOptions: Parameters<typeof readFile>[1] = buildBatchReadOptions(options);
  if (signal) readOptions.signal = signal;
  return processInParallel(
    filesToProcess,
    async (task) => {
      const result = await readSingleFileTask(task, readOptions, pathGuard);
      onReadComplete?.();
      return result;
    },
    PARALLEL_CONCURRENCY,
    signal,
  );
}

function normalizeReadMultipleOptions(options: ReadMultipleOptions): NormalizedReadMultipleOptions {
  const normalized: NormalizedReadMultipleOptions = {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(options.maxSize ?? MAX_TEXT_FILE_SIZE, MAX_TEXT_FILE_SIZE),
    maxTotalSize: options.maxTotalSize ?? DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  };
  applyLineSelection(normalized, options);
  return normalized;
}

function resolveNormalizedReadOptions(options: ReadMultipleOptions): {
  normalized: NormalizedReadMultipleOptions;
  signal?: AbortSignal;
} {
  const { signal, ...rest } = options;
  return { normalized: normalizeReadMultipleOptions(rest), ...(signal ? { signal } : {}) };
}

async function tryValidateFile(
  filePath: string,
  index: number,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<ValidatedFileInfo | undefined> {
  try {
    const validPath = await pathGuard.validateExistingPath(filePath);
    const stats = await withAbort(stat(validPath), signal);
    return { filePath, index, validPath, stats };
  } catch {
    return undefined;
  }
}

async function validateBatch(
  tasks: { filePath: string; index: number }[],
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<Map<number, ValidatedFileInfo>> {
  if (tasks.length === 0) return new Map<number, ValidatedFileInfo>();
  const { results } = await processInParallel(
    tasks,
    async (task) => tryValidateFile(task.filePath, task.index, pathGuard, signal),
    PARALLEL_CONCURRENCY,
    signal,
  );
  const infos = new Map<number, ValidatedFileInfo>();
  for (const info of results) {
    if (!info) continue;
    infos.set(info.index, info);
  }
  return infos;
}

function markRemainingSkipped(startIndex: number, total: number, skippedBudget: Set<number>): void {
  for (let index = startIndex; index < total; index += 1) {
    skippedBudget.add(index);
  }
}

function applyBudget(
  totalSize: number,
  estimatedSize: number,
  maxTotalSize: number,
  index: number,
  totalFiles: number,
  skippedBudget: Set<number>,
): { totalSize: number; exceeded: boolean } {
  if (totalSize + estimatedSize > maxTotalSize) {
    skippedBudget.add(index);
    markRemainingSkipped(index + 1, totalFiles, skippedBudget);
    return { totalSize, exceeded: true };
  }
  return { totalSize: totalSize + estimatedSize, exceeded: false };
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<{ skippedBudget: Set<number>; validated: Map<number, ValidatedFileInfo> }> {
  const skippedBudget = new Set<number>();
  const validated = new Map<number, ValidatedFileInfo>();
  let totalSize = 0;
  const totalFiles = filePaths.length;

  for (let batchStart = 0; batchStart < totalFiles; batchStart += PARALLEL_CONCURRENCY) {
    const batchEnd = Math.min(batchStart + PARALLEL_CONCURRENCY, totalFiles);
    const batchTasks: { filePath: string; index: number }[] = [];
    for (let index = batchStart; index < batchEnd; index += 1) {
      const filePath = filePaths[index];
      if (!filePath || validated.has(index)) continue;
      batchTasks.push({ filePath, index });
    }
    const batchInfos = await validateBatch(batchTasks, pathGuard, signal);
    for (const [index, info] of batchInfos) validated.set(index, info);
    for (let index = batchStart; index < batchEnd; index += 1) {
      const info = validated.get(index);
      if (!info) continue;
      const { exceeded, totalSize: nextTotalSize } = applyBudget(
        totalSize,
        estimateReadSize(info.stats, maxSize),
        maxTotalSize,
        index,
        totalFiles,
        skippedBudget,
      );
      if (exceeded) return { skippedBudget, validated };
      totalSize = nextTotalSize;
    }
  }
  return { skippedBudget, validated };
}

function buildFilesToProcess(
  filePaths: readonly string[],
  validated: Map<number, { validPath: string; stats: Stats }>,
  skippedBudget: Set<number>,
): FileReadTask[] {
  const filesToProcess: FileReadTask[] = [];
  for (let index = 0; index < filePaths.length; index += 1) {
    if (skippedBudget.has(index)) continue;
    const filePath = filePaths[index];
    if (!filePath) continue;
    const cached = validated.get(index);
    if (cached) {
      filesToProcess.push({ filePath, index, validPath: cached.validPath, stats: cached.stats });
      continue;
    }
    filesToProcess.push({ filePath, index });
  }
  return filesToProcess;
}

function applySkippedBudget(
  output: ReadMultipleResult[],
  skippedBudget: Set<number>,
  filePaths: readonly string[],
  maxTotalSize: number,
): void {
  for (const index of skippedBudget) {
    const filePath = filePaths[index];
    if (!filePath) continue;
    output[index] = {
      path: filePath,
      error: new Error(
        `Skipped: combined estimated read would exceed maxTotalSize (${maxTotalSize} bytes)`,
      ),
    };
  }
}

function resolveErrorOriginalIndex(
  failureIndex: number,
  filesToProcess: { index: number }[],
  totalInputFiles: number,
): number | undefined {
  const batchIndex = filesToProcess[failureIndex]?.index;
  if (typeof batchIndex === 'number' && batchIndex >= 0 && batchIndex < totalInputFiles) {
    return batchIndex;
  }
  if (failureIndex >= 0 && failureIndex < totalInputFiles) return failureIndex;
  return undefined;
}

async function readMultipleFiles(
  filePaths: readonly string[],
  options: ReadMultipleOptions = {},
): Promise<ReadMultipleResult[]> {
  if (filePaths.length === 0) return [];
  const { normalized, signal } = resolveNormalizedReadOptions(options);
  const { pathGuard } = options;
  if (!pathGuard) throw new Error('pathGuard is required in ReadMultipleOptions');

  const output: ReadMultipleResult[] = Array.from(filePaths, (fp) => ({ path: fp }));
  const { skippedBudget, validated } = await collectFileBudget(
    filePaths,
    normalized.maxTotalSize,
    normalized.maxSize,
    pathGuard,
    signal,
  );
  const filesToProcess = buildFilesToProcess(filePaths, validated, skippedBudget);
  const { results, errors } = await readFilesInParallel(
    filesToProcess,
    normalized,
    pathGuard,
    signal,
    options.onReadComplete,
  );
  applyIndexedValues(output, results);
  applyIndexedErrors({
    output,
    errors,
    resolveIndex: (failureIndex) =>
      resolveErrorOriginalIndex(failureIndex, filesToProcess, filePaths.length),
    buildValue: (resolvedIndex, error) => ({
      path: filePaths[resolvedIndex] ?? UNKNOWN_PATH,
      error,
    }),
  });
  applySkippedBudget(output, skippedBudget, filePaths, normalized.maxTotalSize);
  return output;
}

type ReadManyOutputItem = z.infer<typeof ReadManyItemSchema>;
type ReadManyResultWithResource = Omit<ReadMultipleResult, 'error'> & {
  error?: ReadManyOutputItem['error'];
  resourceUri?: string;
  mimeType?: string;
  kind?: 'text' | 'binary' | 'image' | 'audio' | 'pdf';
  bytesRead?: number;
  resourceLink?: ReturnType<typeof putResource>['link'];
};

function toStructuredReadManyResult(result: ReadManyResultWithResource): ReadManyOutputItem {
  const structuredResult: ReadManyOutputItem = { path: result.path };
  return assignDefined(structuredResult, {
    resourceUri: result.resourceUri,
    mimeType: result.mimeType,
    kind: result.kind,
    head: result.head,
    tail: result.tail,
    startLine: result.startLine,
    endLine: result.endLine,
    hasMoreLines: result.hasMoreLines ? true : undefined,
    totalLines: result.totalLines,
    linesRead: result.linesRead,
    continuation: buildReadContinuation(result),
    bytesRead: result.bytesRead,
    error: result.error,
  });
}

function maybeExternalizeReadManyResult(
  result: ReadMultipleResult,
  resourceStore?: ResourceStore,
): ReadManyResultWithResource {
  const { error, ...rest } = result;
  const baseResult: ReadManyResultWithResource = {
    ...rest,
    ...(error ? { error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, result.path) } : {}),
    ...(result.content ? { bytesRead: Buffer.byteLength(result.content, 'utf8') } : {}),
  };
  if (!result.content || !resourceStore) return baseResult;
  const contentSample = Buffer.from(result.content.slice(0, MIME_SAMPLE_SIZE));
  const mimeInfo = detectMimeType(result.path, contentSample);
  const { entry, link } = putResource({
    store: resourceStore,
    name: basename(result.path),
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    content: result.content,
  });
  return {
    ...baseResult,
    resourceUri: entry.uri,
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    bytesRead: entry.size,
    resourceLink: link,
  };
}

function buildReadManyResponsePayload(
  results: readonly ReadMultipleResult[],
  resourceStore?: ResourceStore,
): {
  structuredResults: ReadManyOutputItem[];
  summary: { total: number; succeeded: number; failed: number };
  resourceLinks: ReturnType<typeof putResource>['link'][];
} {
  const structuredResults: ReadManyOutputItem[] = [];
  const resourceLinks: ReturnType<typeof putResource>['link'][] = [];
  let succeeded = 0;
  for (const result of results) {
    const mappedResult = maybeExternalizeReadManyResult(result, resourceStore);
    structuredResults.push(toStructuredReadManyResult(mappedResult));
    if (mappedResult.resourceLink) resourceLinks.push(mappedResult.resourceLink);
    if (mappedResult.error === undefined) succeeded += 1;
  }
  const total = structuredResults.length;
  return {
    structuredResults,
    summary: { total, succeeded, failed: total - succeeded },
    resourceLinks,
  };
}

async function handleReadMultipleFiles(
  args: ReadFileInput & { paths: string[] },
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ResourceStore,
  onProgress?: (progress: { current: number; total: number }) => void,
): Promise<RunResult<ReadFileOutput>> {
  const total = args.paths.length;
  let completed = 0;
  const onReadComplete = (): void => {
    completed++;
    onProgress?.({ current: completed, total });
  };
  const results = await readMultipleFiles(args.paths, {
    pathGuard,
    ...(signal ? { signal } : {}),
    ...(args.head !== undefined ? { head: args.head } : {}),
    ...(args.tail !== undefined ? { tail: args.tail } : {}),
    ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
    ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
    onReadComplete,
  });
  const payload = buildReadManyResponsePayload(results, resourceStore);
  const structured: ReadFileOutput = {
    ok: true,
    results: payload.structuredResults,
    summary: payload.summary,
  };
  const summaryText = `read: ${String(payload.summary.total)} file${payload.summary.total === 1 ? '' : 's'}`;
  if (payload.resourceLinks.length > 0) {
    return { structured, text: summaryText, resources: payload.resourceLinks };
  }
  return { structured, text: summaryText };
}

export const READ_FILE = defineTool({
  name: 'read',
  title: 'Read File',
  description:
    'Read a text file. Use head/tail/startLine/endLine for partial line reads; use offset/length for byte-range reads; use read_many for batches.',
  input: ReadFileInputSchema,
  output: ReadFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  execution: { taskSupport: 'forbidden' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: [
    'Large content is externalized to `filesystem-mcp://result/{id}` and preview is returned inline.',
  ],
  defaultErrorCode: ErrorCode.NOT_FILE,
  progress: (args) => {
    const isBatch = args.paths !== undefined;
    const name = isBatch ? `${String(args.paths?.length ?? 0)} files` : basename(args.path ?? '');
    if (isBatch) {
      return { label: READ_TOOL_LABEL, subject: name };
    }
    let scope: string | undefined;
    if (args.offset !== undefined) {
      const end = args.length !== undefined ? args.offset + args.length - 1 : '…';
      scope = `bytes ${args.offset}–${String(end)}`;
    } else if (args.startLine !== undefined) {
      const end = args.endLine ?? '…';
      const subject = `${name}:${args.startLine}-${String(end)}`;
      return { label: READ_TOOL_LABEL, subject };
    } else if (args.head !== undefined) {
      scope = `head ${args.head}`;
    } else if (args.tail !== undefined) {
      scope = `tail ${args.tail}`;
    }
    return { label: READ_TOOL_LABEL, subject: name, ...(scope ? { scope } : {}) };
  },
  progressDone: (args, result) => {
    if (args.paths !== undefined && result.results) {
      const totalBytes = result.results.reduce((sum, r) => sum + (r.bytesRead ?? 0), 0);
      return { detail: formatBytes(totalBytes) };
    }
    if (result.bytesRead !== undefined) {
      return { detail: formatBytes(result.bytesRead) };
    }
    return {};
  },
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
  run: (args, ctx) => {
    if (args.paths !== undefined) {
      return handleReadMultipleFiles(
        args as ReadFileInput & { paths: string[] },
        ctx.pathGuard,
        ctx.signal,
        ctx.resourceStore,
        ctx.onProgress,
      );
    }
    return handleReadFile(
      args as ReadFileInput & { path: string },
      ctx.pathGuard,
      ctx.signal,
      ctx.resourceStore,
    );
  },
});
