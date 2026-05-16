import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { z } from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode } from '../core/errors.js';
import {
  calculateFileContentHash,
  detectMimeType,
  MIME_SAMPLE_SIZE,
  readFile,
  stat,
} from '../core/fs.js';
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
  Sha256Hex,
  singleOrBatchPathsInput,
  validateReadRange,
} from '../schema.js';
import { runOverPaths } from './_helpers.js';
import { defineTool, type PerPathResult, type ToolCtx } from './define.js';

const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

const ReadFileInputSchema = singleOrBatchPathsInput({
  extra: {
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
  },
}).superRefine((value, ctx) => {
  const hasPath = value.path !== undefined;
  const hasPaths = value.paths !== undefined;

  // Preserve root-cause-only validation behavior from the previous schema.
  if (!hasPath && !hasPaths) return;
  if (hasPath && hasPaths) return;

  if (value.paths !== undefined && (value.offset !== undefined || value.length !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['offset'],
      message: "'offset' and 'length' are not supported in batch mode",
      input: value,
    });
    return;
  }

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

const ReadPerPathValueSchema = z.strictObject({
  content: z.string().optional().describe('File content (text)'),
  mimeType: z.string().optional().describe('MIME type'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).optional().describe('File kind'),
  resourceUri: z.string().optional().describe('Per-file resource URI when externalized'),
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
});

const ReadPerPathSchema = z.strictObject({
  path: z.string().describe('Requested path'),
  value: ReadPerPathValueSchema.optional().describe('Read result (success)'),
  error: PerFileErrorSchema.optional().describe('Per-path error'),
});

const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z.array(ReadPerPathSchema).describe('Per-path results (always present)'),
  summary: OperationSummarySchema.describe('Aggregate counts'),
});

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

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
    ? `${result.totalLines - nextStart + 1} lines remain (${nextStart}-${result.totalLines}). Read next chunk with these args.`
    : 'File was truncated. Read next chunk with these args.';
  return {
    tool: 'read',
    args: { path: result.path, startLine: nextStart, endLine: nextEnd },
    hint,
  };
}

type PerPathReadValue = z.infer<typeof ReadPerPathValueSchema>;

interface BatchFileInfo {
  index: number;
  size: number;
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  pathGuard: ToolCtx['pathGuard'],
  signal?: AbortSignal,
): Promise<{ skippedBudget: Set<number> }> {
  const indexed = filePaths.map((path, index) => ({ path, index }));
  const { results } = await processInParallel(
    indexed,
    async ({ path, index }): Promise<BatchFileInfo | undefined> => {
      try {
        const out = await stat(path, pathGuard, signal ? { signal } : undefined);
        return { index, size: Math.min(out.stats.size, maxSize) };
      } catch {
        return undefined;
      }
    },
    PARALLEL_CONCURRENCY,
    signal,
  );

  const byIndex = new Map<number, number>();
  for (const item of results) {
    if (!item) continue;
    byIndex.set(item.index, item.size);
  }

  let total = 0;
  const skippedBudget = new Set<number>();
  for (let i = 0; i < filePaths.length; i += 1) {
    const size = byIndex.get(i);
    if (size === undefined) continue;
    if (total + size > maxTotalSize) {
      for (let j = i; j < filePaths.length; j += 1) skippedBudget.add(j);
      break;
    }
    total += size;
  }

  return { skippedBudget };
}

function preFilterByBudget(
  pathList: readonly string[],
  budgetState: { skippedBudget: Set<number>; maxTotalSize: number },
): { skippedResults: Map<number, PerPathResult<PerPathReadValue>>; survivors: string[] } {
  const skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
  const survivors: string[] = [];

  for (let i = 0; i < pathList.length; i += 1) {
    const path = pathList[i];
    if (path === undefined) continue;
    if (budgetState.skippedBudget.has(i)) {
      skippedResults.set(i, {
        path,
        error: {
          code: ErrorCode.TOO_LARGE,
          message: `Skipped: combined estimated read would exceed maxTotalSize (${String(
            budgetState.maxTotalSize,
          )} bytes)`,
          path,
        },
      });
      continue;
    }
    survivors.push(path);
  }

  return { skippedResults, survivors };
}

async function readOnePath(
  filePath: string,
  args: ReadFileInput,
  ctx: ToolCtx,
): Promise<PerPathReadValue> {
  const options = buildReadOptions(args, ctx.signal);
  const result = await readFile(filePath, options, ctx.pathGuard);

  const mimeInfo = detectMimeType(
    result.path,
    Buffer.from(result.content.slice(0, MIME_SAMPLE_SIZE)),
  );

  const value: PerPathReadValue = {
    content: result.content,
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
  };

  if (result.hasMoreLines) {
    const continuation = buildReadContinuation({
      path: result.path,
      hasMoreLines: true,
      ...(result.linesRead !== undefined ? { linesRead: result.linesRead } : {}),
      ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
      ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
      ...(result.head !== undefined ? { head: result.head } : {}),
      ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
    });
    if (continuation) value.continuation = continuation;
  }

  if (result.totalLines !== undefined) value.totalLines = result.totalLines;
  if (result.linesRead !== undefined) value.linesRead = result.linesRead;
  if (result.hasMoreLines) value.hasMoreLines = true;
  if (result.head !== undefined) value.head = result.head;
  if (result.tail !== undefined) value.tail = result.tail;
  if (result.startLine !== undefined) value.startLine = result.startLine;
  if (result.endLine !== undefined) value.endLine = result.endLine;
  if (result.offset !== undefined) value.offset = result.offset;
  if (result.bytesRead !== undefined) value.bytesRead = result.bytesRead;
  if (result.reachedEOF !== undefined) value.reachedEOF = result.reachedEOF;

  if (args.includeHash) {
    value.contentHash = await calculateFileContentHash(result.path, ctx.signal);
  }

  if (ctx.resourceStore) {
    value.resourceUri = `filesystem-mcp://file/${result.path.replace(/\\/g, '/')}`;
  }

  return value;
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
  execution: { taskSupport: 'optional' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  nuances: [
    'Large content is externalized to `filesystem-mcp://file/{path}` and the value carries `resourceUri`.',
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
      const end = args.length !== undefined ? args.offset + args.length - 1 : '...';
      scope = `bytes ${args.offset}-${String(end)}`;
    } else if (args.startLine !== undefined) {
      const end = args.endLine ?? '...';
      scope = `${args.startLine}-${String(end)}`;
    } else if (args.head !== undefined) {
      scope = `head ${args.head}`;
    } else if (args.tail !== undefined) {
      scope = `tail ${args.tail}`;
    }
    return { label: READ_TOOL_LABEL, subject: name, ...(scope ? { scope } : {}) };
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
  run: async (args, ctx) => {
    let pathList: string[];
    let skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
    let survivors: string[];

    if (args.paths !== undefined) {
      pathList = args.paths;
      const budget = await collectFileBudget(
        pathList,
        DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
        MAX_TEXT_FILE_SIZE,
        ctx.pathGuard,
        ctx.signal,
      );
      const filtered = preFilterByBudget(pathList, {
        skippedBudget: budget.skippedBudget,
        maxTotalSize: DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
      });
      skippedResults = filtered.skippedResults;
      survivors = filtered.survivors;
    } else {
      pathList = [args.path ?? ''];
      survivors = [...pathList];
    }

    const batchInput =
      survivors.length === 1 && args.path !== undefined
        ? { path: survivors[0] }
        : { paths: survivors };

    const batch = await runOverPaths<undefined, PerPathReadValue>(
      batchInput,
      ctx,
      ({ path }) => readOnePath(path, args, ctx),
      { defaultErrorCode: ErrorCode.NOT_FILE },
    );

    const survivorIter = batch.results[Symbol.iterator]();
    const ordered: PerPathResult<PerPathReadValue>[] = pathList.map((path, idx) => {
      const skipped = skippedResults.get(idx);
      if (skipped) return skipped;
      const next = survivorIter.next().value;
      return (
        next ?? {
          path,
          error: { code: ErrorCode.UNKNOWN, message: 'Unknown read failure' },
        }
      );
    });

    const failed = ordered.filter((r) => r.error !== undefined).length;
    const summary = {
      total: ordered.length,
      succeeded: ordered.length - failed,
      failed,
    };

    const resources: ContentBlock[] = [];
    for (const result of ordered) {
      if (!result.value?.resourceUri || !result.value.content) continue;
      resources.push({
        type: 'resource_link',
        uri: result.value.resourceUri,
        name: basename(result.path),
        mimeType: result.value.mimeType ?? 'application/octet-stream',
        size: Buffer.byteLength(result.value.content, 'utf8'),
        annotations: { audience: ['user', 'assistant'] },
      });
    }

    const text =
      summary.total === 1
        ? `read: ${basename(ordered[0]?.path ?? '')}`
        : `read: ${String(summary.total)} file${summary.total === 1 ? '' : 's'}`;

    return {
      structured: { ok: true as const, results: ordered, summary },
      text,
      ...(resources.length > 0 ? { resources } : {}),
    };
  },
});
