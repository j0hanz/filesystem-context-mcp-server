import type { ContentBlock } from '@modelcontextprotocol/server';

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { basename } from 'node:path';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode } from '../core/errors.js';
import { buildFileResourceLink, buildFileResourceUri } from '../core/file-uri.js';
import { detectMimeFromContent } from '../core/mime.js';
import { Logger } from '../core/observability.js';
import type { ReadFileResult, ReadSpec } from '../core/read.js';
import { readFileWithStats } from '../core/read.js';
import {
  completableOptionalPath,
  ContinuationSchema,
  createReadRangeFields,
  defaultFalseBoolean,
  FileKind,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  Sha256Hex,
  singleOrBatchAccessPaths,
  singleOrBatchPathsInput,
  validateReadRange,
} from '../core/schema.js';
import {
  DEFAULT_CONTINUATION_CHUNK_SIZE,
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import type { PerPathResult } from './batch.js';
import { runOverPaths } from './batch.js';
import type { ToolCtx } from './define.js';
import { defineTool } from './define.js';

const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

export function createReadFileInputSchema(pathSchema?: z.ZodType) {
  return singleOrBatchPathsInput({
    extra: {
      includeHash: defaultFalseBoolean(
        'Include SHA-256 hash of the returned content in the response',
      ),
      ...readRangeFields,
      offset: z
        .uint32()
        .optional()
        .describe(
          'Byte offset at which to start reading (single-file mode only; mutually exclusive with head/tail/startLine/endLine)',
        ),
      length: z
        .uint32()
        .min(1)
        .optional()
        .describe(
          'Number of bytes to read starting at offset (single-file mode only; reads to EOF when omitted)',
        ),
    },
    pathSchema,
  }).superRefine((value, ctx) => {
    const hasPaths = value.paths !== undefined;

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

    // Batch mode: offset/length are single-file-only.
    if (hasPaths && (value.offset !== undefined || value.length !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['offset'],
        message: "'offset' and 'length' are not supported in batch mode",
        input: value,
      });
    }
  });
}

const ReadFileInputSchema = createReadFileInputSchema();

const ReadPerPathValueSchema = z.strictObject({
  content: z.string().optional().describe('File text content'),
  mimeType: z.string().optional().describe('Detected MIME type (e.g. text/typescript)'),
  kind: FileKind.optional().describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'Resource URI for externalized content (present when file is stored in resource store)',
    ),
  continuation: ContinuationSchema.optional().describe(
    'Next-read arguments; present when content was truncated due to size limits',
  ),
  totalLines: NonNegInt.optional().describe('Total line count in the full file'),
  linesRead: NonNegInt.optional().describe('Number of lines returned in this response'),
  hasMoreLines: z
    .boolean()
    .optional()
    .describe('True when additional lines remain beyond what was returned'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: Sha256Hex.optional().describe(
    'SHA-256 hex digest of the returned content (present when includeHash=true)',
  ),
  offset: NonNegInt.optional().describe('Byte offset at which reading started'),
  bytesRead: NonNegInt.optional().describe('Number of bytes returned in this response'),
  reachedEOF: z.boolean().optional().describe('True when the read reached the end of the file'),
});

const ReadPerPathSchema = z.strictObject({
  path: z.string().describe('The requested file path'),
  value: ReadPerPathValueSchema.optional().describe('Read result; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; errors are reported per-path in results[].error'),
  results: z.array(ReadPerPathSchema).describe('Per-path results ordered to match the input paths'),
  summary: OperationSummarySchema.describe('Aggregate counts: total, succeeded, failed'),
});

type ReadFileInput = z.infer<typeof ReadFileInputSchema>;

export { ReadFileInputSchema };

const READ_TOOL_LABEL = 'Read';

interface ReadSpecCommon {
  encoding: BufferEncoding;
  maxSize: number;
  skipBinary: true;
  signal?: AbortSignal;
}

function buildReadSpec(args: ReadFileInput, signal?: AbortSignal): ReadSpec {
  const common: ReadSpecCommon = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
    ...(signal ? { signal } : {}),
  };
  const { offset, length, head, tail, startLine, endLine } = args;

  if (offset !== undefined || length !== undefined) {
    return {
      kind: 'byteRange',
      ...(offset !== undefined ? { offset } : {}),
      ...(length !== undefined ? { length } : {}),
      ...common,
    };
  }
  if (head !== undefined) return { kind: 'head', lines: head, ...common };
  if (tail !== undefined) return { kind: 'tail', lines: tail, ...common };
  if (startLine !== undefined || endLine !== undefined) {
    return {
      kind: 'range',
      start: startLine ?? 1,
      ...(endLine !== undefined ? { end: endLine } : {}),
      ...common,
    };
  }
  return { kind: 'full', ...common };
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
  validPath: string;
  stats: Stats;
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  ctx: Pick<ToolCtx, 'fs' | 'signal'>,
): Promise<{
  skippedBudget: Set<number>;
  known: Map<string, { validPath: string; stats: Stats }>;
}> {
  const indexed = filePaths.map((path, index) => ({ path, index }));
  const { results } = await processInParallel(
    indexed,
    async ({ path, index }): Promise<BatchFileInfo | undefined> => {
      try {
        const out = await ctx.fs.stat(path);
        return {
          index,
          size: Math.min(out.stats.size, maxSize),
          validPath: out.validPath,
          stats: out.stats,
        };
      } catch (err: unknown) {
        Logger.debug(`collectFileBudget: stat failed for "${path}": ${String(err)}`);
        return undefined;
      }
    },
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const byIndex = new Map<number, number>();
  const known = new Map<string, { validPath: string; stats: Stats }>();
  for (const { value: item } of results) {
    if (!item) continue;
    byIndex.set(item.index, item.size);
    // Keyed by the ORIGINAL requested path string (not validPath) — that's
    // what readOnePath is called with downstream, and what filePaths[i]
    // holds.
    const requestedPath = filePaths[item.index];
    if (requestedPath !== undefined) {
      known.set(requestedPath, { validPath: item.validPath, stats: item.stats });
    }
  }

  let total = 0;
  const skippedBudget = new Set<number>();
  for (let i = 0; i < filePaths.length; i += 1) {
    const size = byIndex.get(i);
    if (size === undefined) continue;
    if (total + size > maxTotalSize) {
      // Only mark files that were actually stat'd as too large for the batch
      // budget. A file whose stat already failed (byIndex undefined) must fall
      // through to survivors so its read surfaces the real error (NOT_FILE /
      // permission) — not a misleading TOO_LARGE.
      for (let j = i; j < filePaths.length; j += 1) {
        if (byIndex.get(j) === undefined) continue;
        skippedBudget.add(j);
      }
      break;
    }
    total += size;
  }

  return { skippedBudget, known };
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

function buildPerPathReadValue(
  result: ReadFileResult,
  options: { includeHash?: boolean; hasResourceStore?: boolean },
): PerPathReadValue {
  const mimeInfo = detectMimeFromContent(result.path, result.content);
  const continuation =
    result.hasMoreLines && result.readMode !== 'tail'
      ? buildReadContinuation({
          path: result.path,
          hasMoreLines: true,
          ...(result.linesRead !== undefined ? { linesRead: result.linesRead } : {}),
          ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
          ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
          ...(result.head !== undefined ? { head: result.head } : {}),
          ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
        })
      : undefined;
  const contentHash = options.includeHash
    ? createHash('sha256').update(result.content, 'utf-8').digest('hex')
    : undefined;
  const resourceUri = options.hasResourceStore ? buildFileResourceUri(result.path) : undefined;

  return {
    content: result.content,
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    ...(continuation ? { continuation } : {}),
    ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
    ...(result.linesRead !== undefined ? { linesRead: result.linesRead } : {}),
    ...(result.hasMoreLines ? { hasMoreLines: true } : {}),
    ...(result.head !== undefined ? { head: result.head } : {}),
    ...(result.tail !== undefined ? { tail: result.tail } : {}),
    ...(result.startLine !== undefined ? { startLine: result.startLine } : {}),
    ...(result.endLine !== undefined ? { endLine: result.endLine } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
    ...(result.offset !== undefined ? { offset: result.offset } : {}),
    ...(result.bytesRead !== undefined ? { bytesRead: result.bytesRead } : {}),
    ...(result.reachedEOF !== undefined ? { reachedEOF: result.reachedEOF } : {}),
    ...(resourceUri !== undefined ? { resourceUri } : {}),
  };
}

async function readOnePath(
  filePath: string,
  args: ReadFileInput,
  ctx: ToolCtx,
  known?: { validPath: string; stats: Stats },
): Promise<PerPathReadValue> {
  const spec = buildReadSpec(args, ctx.signal);
  const result = known
    ? await readFileWithStats(filePath, known.validPath, known.stats, spec)
    : await ctx.fs.readFile(filePath, spec);

  return buildPerPathReadValue(result, {
    includeHash: args.includeHash,
    hasResourceStore: ctx.resourceStore !== undefined,
  });
}

export const READ_FILE = defineTool({
  name: 'read',
  title: 'Read File',
  description:
    'Read one or more text files and return content. ' +
    'Partial line reads: head (first N lines), tail (last N lines), startLine/endLine (line range). ' +
    'Byte-range reads: offset/length (single-file only; mutually exclusive with line params). ' +
    'Batch mode: pass paths[] instead of path; line/byte params are shared across all files.',
  input: ReadFileInputSchema,
  buildInput: (guard) =>
    createReadFileInputSchema(
      completableOptionalPath(
        guard,
        'path',
        'Single file path; mutually exclusive with paths and files',
      ),
    ),
  output: ReadFileOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
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
  accessPaths: singleOrBatchAccessPaths,
  run: async (args, ctx) => {
    let pathList: string[];
    let skippedResults = new Map<number, PerPathResult<PerPathReadValue>>();
    let survivors: string[];
    let known = new Map<string, { validPath: string; stats: Stats }>();

    if (args.paths !== undefined) {
      pathList = args.paths;
      const budget = await collectFileBudget(
        pathList,
        DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
        MAX_TEXT_FILE_SIZE,
        ctx,
      );
      known = budget.known;
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

    const firstSurvivor = survivors[0];
    const batchInput =
      firstSurvivor !== undefined && survivors.length === 1 && args.path !== undefined
        ? { path: firstSurvivor }
        : { paths: survivors };

    // Every path can be budget-skipped (a single file over maxTotalSize does
    // it), and runOverPaths rejects an empty list. The per-path TOO_LARGE
    // results are already built — return those rather than failing the call.
    const batch =
      survivors.length === 0
        ? { results: [] as PerPathResult<PerPathReadValue>[] }
        : await runOverPaths<undefined, PerPathReadValue>(
            batchInput,
            ctx,
            ({ path }) => readOnePath(path, args, ctx, known.get(path)),
            { defaultErrorCode: ErrorCode.NOT_FILE },
          );

    const resultMap = new Map(batch.results.map((r) => [r.path, r]));
    const ordered: PerPathResult<PerPathReadValue>[] = pathList.map((path, idx) => {
      const skipped = skippedResults.get(idx);
      if (skipped) return skipped;
      const result = resultMap.get(path);
      return (
        result ?? {
          path,
          error: { code: ErrorCode.UNKNOWN, message: 'Unknown read failure' },
        }
      );
    });

    const failed = ordered.filter((r) => 'error' in r).length;
    const summary = {
      total: ordered.length,
      succeeded: ordered.length - failed,
      failed,
    };

    const resources: ContentBlock[] = [];
    for (const result of ordered) {
      if ('error' in result) continue;
      if (!result.value.resourceUri || !result.value.content) continue;
      resources.push(
        buildFileResourceLink(
          result.path,
          result.value.mimeType ?? 'application/octet-stream',
          Buffer.byteLength(result.value.content, 'utf8'),
        ),
      );
    }

    const [firstOrdered] = ordered;
    const text =
      ordered.length === 1 && firstOrdered !== undefined
        ? 'error' in firstOrdered
          ? firstOrdered.error.message
          : (firstOrdered.value.content ?? 'read failed')
        : ordered
            .map((r) => {
              const header = `// ${r.path}`;
              if ('value' in r) return `${header}\n${r.value.content}`;
              return `${header}\n// Error: ${r.error.message}`;
            })
            .join('\n\n');

    return {
      structured: { ok: true as const, results: ordered, summary },
      text,
      ...(resources.length > 0 ? { resources } : {}),
    };
  },
});
