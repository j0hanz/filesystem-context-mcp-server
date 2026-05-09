import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { z } from 'zod/v4';

import { NonNegInt, PositiveInt, RequiredPath } from '../schemas/fields.js';
import { readRangeConstraints, toToolJsonSchema } from '../schemas/json-schema.js';
import {
  ContinuationSchema,
  createReadRangeFields,
  OperationSummarySchema,
  PerFileErrorSchema,
  validateReadRange,
} from '../schemas/shared.js';

import { processInParallel, withAbort } from '../core/concurrency.js';
import { ErrorCode } from '../core/errors.js';
import {
  applyIndexedErrors,
  applyIndexedValues,
  detectMimeType,
  readFile,
  readFileWithStats,
} from '../core/fs.js';
import type { PathGuard } from '../core/path.js';
import {
  assignDefined,
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import { defineTool } from './define-tool.js';
import { FILE_READ_ICONS } from './icons.js';
import {
  buildBatchPathContext,
  buildResourceLink,
  buildResourceResponse,
  buildStructuredError,
  putResource,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
} from './shared.js';
import {
  completeProgressSession,
  createBatchProgressCallbacks,
  resolveFinalProgressCurrent,
} from './tool-execution.js';

// ---------------------------------------------------------------------------
// readMultipleFiles implementation (inlined from file-operations/metadata.ts)
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

function estimateReadSize(stats: Stats, maxSize: number): number {
  return Math.min(stats.size, maxSize);
}

type ReadFileOptions = LineSelectionOptions & {
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

function buildReadOptions(options: NormalizedReadMultipleOptions): ReadFileOptions {
  const readOptions: ReadFileOptions = {
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

async function readSingleFile(
  task: FileReadTask,
  readOptions: Parameters<typeof readFile>[1],
  pathGuard: PathGuard,
): Promise<{ index: number; value: ReadMultipleResult }> {
  const { filePath, index, validPath, stats } = task;
  const result =
    validPath && stats
      ? await readFileWithStats(filePath, validPath, stats, readOptions, pathGuard)
      : await readFile(filePath, readOptions, pathGuard);

  return {
    index,
    value: buildReadMultipleResult(filePath, result),
  };
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
  const readOptions: Parameters<typeof readFile>[1] = buildReadOptions(options);
  if (signal) {
    readOptions.signal = signal;
  }
  return processInParallel(
    filesToProcess,
    async (task) => {
      const result = await readSingleFile(task, readOptions, pathGuard);
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
  return {
    normalized: normalizeReadMultipleOptions(rest),
    ...(signal ? { signal } : {}),
  };
}

interface ValidatedFileInfo {
  index: number;
  filePath: string;
  validPath: string;
  stats: Stats;
}

async function validateFile(
  filePath: string,
  index: number,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<ValidatedFileInfo> {
  const validPath = await pathGuard.validateExistingPath(filePath);
  const stats = await withAbort(stat(validPath), signal);
  return { filePath, index, validPath, stats };
}

function markRemainingSkipped(startIndex: number, total: number, skippedBudget: Set<number>): void {
  for (let index = startIndex; index < total; index += 1) {
    skippedBudget.add(index);
  }
}

async function tryValidateFile(
  filePath: string,
  index: number,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<ValidatedFileInfo | undefined> {
  try {
    return await validateFile(filePath, index, pathGuard, signal);
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
): Promise<{
  skippedBudget: Set<number>;
  validated: Map<number, ValidatedFileInfo>;
}> {
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

function buildOutput(filePaths: readonly string[]): ReadMultipleResult[] {
  return Array.from(filePaths, (fp) => ({ path: fp }));
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
  if (failureIndex >= 0 && failureIndex < totalInputFiles) {
    return failureIndex;
  }
  return undefined;
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
      filesToProcess.push({
        filePath,
        index,
        validPath: cached.validPath,
        stats: cached.stats,
      });
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

async function readMultipleFiles(
  filePaths: readonly string[],
  options: ReadMultipleOptions = {},
): Promise<ReadMultipleResult[]> {
  if (filePaths.length === 0) return [];

  const { normalized, signal } = resolveNormalizedReadOptions(options);
  const { pathGuard } = options;

  if (!pathGuard) {
    throw new Error('pathGuard is required in ReadMultipleOptions');
  }

  const output = buildOutput(filePaths);
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

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const readManyRangeFields = createReadRangeFields({
  head: 'Return first N lines from each',
  tail: 'Return last N lines from each',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

const ReadManyInputSchema = z
  .strictObject({
    paths: z.array(RequiredPath).min(1).describe('File paths to read'),
    ...readManyRangeFields,
  })
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
      },
      ctx,
    );
  });

const ReadManyOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        resourceUri: z.string().optional().describe('Full content URI'),
        mimeType: z.string().optional().describe('MIME type of the file'),
        kind: z
          .enum(['text', 'binary', 'image', 'audio', 'pdf'])
          .optional()
          .describe('File kind: text, binary, image, audio, or pdf'),
        totalLines: NonNegInt.optional().describe('Total lines'),
        linesRead: NonNegInt.optional().describe('Lines returned'),
        hasMoreLines: z.boolean().optional().describe('More lines available'),
        head: PositiveInt.optional().describe('Head lines requested'),
        tail: PositiveInt.optional().describe('Tail lines requested'),
        startLine: PositiveInt.optional().describe('Start line'),
        endLine: PositiveInt.optional().describe('End line'),
        continuation: ContinuationSchema.optional().describe(
          'Present when file was cut; call the named tool with the given args to continue',
        ),
        error: PerFileErrorSchema.optional().describe('Per-file error'),
      }),
    )
    .describe('Per-file read results'),
  summary: OperationSummarySchema.describe('Operation summary'),
});

const READ_MANY_TOOL: ToolContract = {
  name: 'read_many',
  title: 'Read Multiple Files',
  description:
    'Read multiple text files in one request with contents and metadata. ' +
    'For a single file, use `read`.',
  inputSchema: ReadManyInputSchema,
  inputSchemaJson: toToolJsonSchema(ReadManyInputSchema, (s) => ({
    ...s,
    allOf: [...(Array.isArray(s.allOf) ? (s.allOf as unknown[]) : []), ...readRangeConstraints()],
  })),
  outputSchema: ReadManyOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  nuances: ['Per-file failures land in `results[].error`; the call still returns `isError:false`.'],
  gotchas: ['One `defaultTimeoutMs` covers the whole batch — slow disks may starve later files.'],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

const READ_MANY_TOOL_LABEL = READ_MANY_TOOL.title;

type ReadManyInput = z.infer<typeof ReadManyInputSchema>;
type ReadManyOutput = z.infer<typeof ReadManyOutputSchema>;
type ReadManyOutputItem = NonNullable<ReadManyOutput['results']>[number];
type ReadManyResult = ReadMultipleResult;
type ReadManyResultWithResource = Omit<ReadManyResult, 'error'> & {
  error?: ReadManyOutputItem['error'];
  resourceUri?: string;
  mimeType?: string;
  kind?: 'text' | 'binary' | 'image' | 'audio' | 'pdf';
};

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

function toStructuredReadManyResult(result: ReadManyResultWithResource): ReadManyOutputItem {
  const structuredResult: ReadManyOutputItem = {
    path: result.path,
  };

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
    error: result.error,
  });
}

function maybeExternalizeReadManyResult(
  result: ReadManyResult,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
): ReadManyResultWithResource {
  const { error, ...rest } = result;
  const baseResult: ReadManyResultWithResource = {
    ...rest,
    ...(error ? { error: buildStructuredError(error, ErrorCode.UNKNOWN, result.path) } : {}),
  };

  if (!result.content) {
    return baseResult;
  }

  if (!resourceStore) {
    return baseResult;
  }

  // Detect MIME type from file path and content sample
  const contentSample = Buffer.from(result.content.slice(0, 512));
  const mimeInfo = detectMimeType(result.path, contentSample);

  // Store the content in the resource store
  const { entry } = putResource({
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
  };
}

function buildReadManyTextSection(result: ReadManyResultWithResource): string {
  if (result.error) {
    return `${result.path} [ERROR: ${result.error.code}]`;
  }

  const parts: string[] = [basename(result.path)];
  if (result.totalLines !== undefined) {
    parts.push(`${result.totalLines} lines`);
  }
  return parts.join(' · ');
}

function buildReadMultipleOptions(
  args: ReadManyInput,
  signal?: AbortSignal,
  onReadComplete?: () => void,
): ReadMultipleOptions {
  const options: ReadMultipleOptions = {};

  return assignDefined(options, {
    signal,
    head: args.head,
    tail: args.tail,
    startLine: args.startLine,
    endLine: args.endLine,
    onReadComplete,
  });
}

function buildReadManyResponsePayload(
  results: readonly ReadManyResult[],
  resourceStore?: ToolRegistrationOptions['resourceStore'],
): {
  resourceLinks: ReturnType<typeof buildResourceLink>[];
  structuredResults: ReadManyOutputItem[];
  summary: ReadManyOutput['summary'];
  text: string;
} {
  const resourceLinks: ReturnType<typeof buildResourceLink>[] = [];
  const structuredResults: ReadManyOutputItem[] = [];
  const textLines: string[] = [];
  let succeeded = 0;

  for (const result of results) {
    const mappedResult = maybeExternalizeReadManyResult(result, resourceStore);
    structuredResults.push(toStructuredReadManyResult(mappedResult));
    textLines.push(buildReadManyTextSection(mappedResult));

    if (mappedResult.resourceUri && !mappedResult.error) {
      resourceLinks.push(
        buildResourceLink({
          uri: mappedResult.resourceUri,
          name: basename(mappedResult.path),
          ...(mappedResult.mimeType ? { mimeType: mappedResult.mimeType } : {}),
        }),
      );
    }

    if (mappedResult.error === undefined) succeeded += 1;
  }

  const total = structuredResults.length;
  const summaryText = `read_many: ${total} files\n- ${textLines.join('\n- ')}`;

  return {
    resourceLinks,
    structuredResults,
    summary: {
      total,
      succeeded,
      failed: total - succeeded,
    },
    text: summaryText,
  };
}

async function handleReadMultipleFiles(
  args: ReadManyInput,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onReadComplete?: () => void,
): Promise<ToolResponse<ReadManyOutput>> {
  const options = buildReadMultipleOptions(args, signal, onReadComplete);
  options.pathGuard = pathGuard;
  const results = await readMultipleFiles(args.paths, options);
  const payload = buildReadManyResponsePayload(results, resourceStore);

  const structured: ReadManyOutput = {
    ok: true,
    results: payload.structuredResults,
    summary: payload.summary,
  };

  return buildResourceResponse({
    summary: payload.text,
    resources: payload.resourceLinks,
    structured,
  });
}

export const READ_MANY = defineTool<ReadManyInput, ReadManyOutput>({
  contract: READ_MANY_TOOL,
  defaultErrorCode: ErrorCode.NOT_FILE,
  diagnosticsContext: (args) => ({ path: args.paths[0] ?? '' }),
  run: async (args, ctx) => {
    const context = buildBatchPathContext(args.paths, 'files');
    const label = `${READ_MANY_TOOL_LABEL}: ${context}`;
    const { progress, onItemComplete: rawOnItemComplete } = createBatchProgressCallbacks(ctx, {
      toolLabel: READ_MANY_TOOL_LABEL,
      context,
      totalItems: args.paths.length,
      itemVerb: 'read',
    });

    let itemsDone = 0;
    const onItemComplete = (): void => {
      rawOnItemComplete();
      itemsDone++;
      progress.status(`${label} [${itemsDone}/${args.paths.length} read]`);
    };

    return completeProgressSession(progress, label, async () => {
      const result = await handleReadMultipleFiles(
        args,
        ctx.pathGuard,
        ctx.signal,
        ctx.resourceStore,
        onItemComplete,
      );

      const sc = result.structuredContent;
      const total = sc.summary.total;
      const failed = sc.summary.failed;
      const suffix = failed ? `${failed} failed` : 'done';
      const finalCurrent = resolveFinalProgressCurrent(progress, total);
      return { value: result, suffix, finalCurrent };
    });
  },
});
