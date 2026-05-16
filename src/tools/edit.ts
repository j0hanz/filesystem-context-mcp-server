import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { createTwoFilesPatch, diffLines } from 'diff';
import RE2 from 're2';
import { z } from 'zod/v4';

import { processInParallel, runInWorker, shouldOffload } from '../core/concurrency.js';
import { ErrorCode, McpError, Problem } from '../core/errors.js';
import {
  atomicWriteFile,
  detectMimeType,
  MIME_SAMPLE_SIZE,
  readFileWithStats,
  stat,
} from '../core/fs.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { MAX_TEXT_FILE_SIZE, PARALLEL_CONCURRENCY } from '../core/util.js';
import {
  defaultFalseBoolean,
  IsoDateTime,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  RequiredPath,
} from '../schema.js';
import { formatBytes } from './_helpers.js';
import { defineTool, type RunResult, type ToolCtx } from './define.js';

const EditSpecSchema = z.strictObject({
  oldText: z
    .string()
    .min(1, 'oldText required')
    .describe('Exact text to find (must match literally)')
    .meta({ examples: ['const x = 1;', 'function oldName('] }),
  newText: z
    .string()
    .describe('Replacement text (empty string to delete)')
    .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
});

const FileEditEntrySchema = z.strictObject({
  path: RequiredPath.describe('File path'),
  edits: z.array(EditSpecSchema).min(1).describe('Edits for this file'),
});

const MAX_MULTI_FILES = 5;

const EditFileInputSchema = z
  .strictObject({
    path: RequiredPath.optional().describe('File path (single-file mode)'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(MAX_MULTI_FILES)
      .optional()
      .describe(`File paths; same edits applied to each (max ${MAX_MULTI_FILES})`),
    files: z
      .array(FileEditEntrySchema)
      .min(1)
      .max(MAX_MULTI_FILES)
      .optional()
      .describe(`Per-file edits (max ${MAX_MULTI_FILES})`),
    edits: z
      .array(EditSpecSchema)
      .min(1)
      .optional()
      .describe('Edits applied to path or every entry in paths (forbidden when using files)'),

    dryRun: defaultFalseBoolean('Preview changes without writing'),
    ignoreWhitespace: defaultFalseBoolean('Ignore leading/trailing whitespace when matching'),
  })
  .superRefine((value, ctx) => {
    const modes = [value.path !== undefined, value.paths !== undefined, value.files !== undefined];
    const provided = modes.filter(Boolean).length;
    if (provided === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Provide exactly one of 'path', 'paths', or 'files'",
        input: value,
      });
      return;
    }
    if (provided > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Use only one of 'path', 'paths', or 'files'",
        input: value,
      });
      return;
    }
    if ((value.path !== undefined || value.paths !== undefined) && value.edits === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' required when using 'path' or 'paths'",
        input: value,
      });
    }
    if (value.files !== undefined && value.edits !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' not allowed with 'files'; each file carries its own edits",
        input: value,
      });
    }
  });

const PerFileResultSchema = z.strictObject({
  path: z.string().describe('File path'),
  size: NonNegInt.describe('File size in bytes'),
  lineCount: NonNegInt.describe('Number of lines'),
  mimeType: z.string().describe('MIME type'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).describe('File kind'),
  resourceUri: z.string().describe('Resource URI'),
  modified: IsoDateTime.describe('Modified (ISO 8601 UTC)'),
  appliedEdits: NonNegInt.describe('Edits applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  diff: z.string().optional().describe('Unified diff (dryRun or when changes present)'),
  unmatchedEdits: z.array(z.string()).optional().describe('oldText with no match'),
  lineRange: z.tuple([PositiveInt, PositiveInt]).optional().describe('[firstLine, lastLine]'),
});

const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  // Single-file fields
  path: z.string().optional().describe('File path (single-file mode)'),
  size: NonNegInt.optional().describe('File size in bytes'),
  lineCount: NonNegInt.optional().describe('Number of lines'),
  mimeType: z.string().optional().describe('MIME type'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).optional().describe('File kind'),
  resourceUri: z.string().optional().describe('Resource URI'),
  modified: IsoDateTime.optional().describe('Modified (ISO 8601 UTC)'),
  appliedEdits: NonNegInt.optional().describe('Edits applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  diff: z.string().optional().describe('Unified diff of changes'),
  unmatchedEdits: z.array(z.string()).optional().describe('oldText with no match'),
  lineRange: z.tuple([PositiveInt, PositiveInt]).optional().describe('[firstLine, lastLine]'),
  // Multi-file fields
  results: z.array(PerFileResultSchema).optional().describe('Per-file successes (multi mode)'),
  failures: z
    .array(z.strictObject({ path: z.string(), error: PerFileErrorSchema }))
    .optional()
    .describe('Per-file hard failures (multi mode)'),
  summary: OperationSummarySchema.optional().describe('Aggregate counts (multi mode)'),
});

type EditInput = z.infer<typeof EditFileInputSchema>;
type EditOutput = z.infer<typeof EditFileOutputSchema>;

interface TextRange {
  startIndex: number;
  length: number;
}

interface EditResult {
  content: string;
  appliedEdits: number;
  unmatchedEdits: string[];
  linesAdded: number;
  linesRemoved: number;
  diff?: string;
  lineRange?: [number, number];
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLineNumberAtIndex(str: string, maxIndex: number = str.length): number {
  let count = 1;
  let pos = 0;
  while (pos < maxIndex) {
    pos = str.indexOf('\n', pos);
    if (pos === -1 || pos >= maxIndex) break;
    count++;
    pos++;
  }
  return count;
}

function countLines(str: string): number {
  return getLineNumberAtIndex(str);
}

async function computeDiffStats(
  original: string,
  modified: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const totalBytes = Buffer.byteLength(original) + Buffer.byteLength(modified);
  if (shouldOffload(totalBytes)) {
    return runInWorker('computeDiffStats', { oldStr: original, newStr: modified });
  }
  return new Promise((resolve) => {
    // Yield to the event loop so we don't completely block
    setImmediate(() => {
      diffLines(original, modified, {
        callback: (changes) => {
          let linesAdded = 0;
          let linesRemoved = 0;

          for (const part of changes) {
            if (part.added) {
              linesAdded += part.count;
            } else if (part.removed) {
              linesRemoved += part.count;
            }
          }

          resolve({ linesAdded, linesRemoved });
        },
      });
    });
  });
}

function findEditMatch(
  content: string,
  oldText: string,
  ignoreWhitespace: boolean,
  regexCache?: Map<string, RE2>,
): TextRange | undefined {
  if (ignoreWhitespace) {
    const pattern = escapeRegExp(oldText).replace(/\s+/g, '\\s+');
    let regex = regexCache?.get(pattern);
    if (!regex) {
      regex = new RE2(pattern);
      if (regexCache) regexCache.set(pattern, regex);
    }
    const match = regex.exec(content);

    if (!match) {
      return undefined;
    }

    return {
      startIndex: match.index,
      length: match[0].length,
    };
  }

  const index = content.indexOf(oldText);
  if (index === -1) {
    return undefined;
  }

  return {
    startIndex: index,
    length: oldText.length,
  };
}

function replaceEditMatch(content: string, match: TextRange, newText: string): string {
  return (
    content.slice(0, match.startIndex) + newText + content.slice(match.startIndex + match.length)
  );
}

function mergeLineRange(
  currentRange: EditResult['lineRange'],
  content: string,
  matchStartIndex: number,
  newText: string,
): [number, number] {
  const startLine = getLineNumberAtIndex(content, matchStartIndex);
  const endLine = startLine + countLines(newText) - 1;

  if (!currentRange) {
    return [startLine, endLine];
  }

  return [Math.min(currentRange[0], startLine), Math.max(currentRange[1], endLine)];
}

interface BuildStructuredEditOutputParams {
  validPath: string;
  size: number;
  lineCount: number;
  mimeType: string;
  kind: 'text' | 'binary' | 'image' | 'audio' | 'pdf';
  resourceUri: string;
  modified: string;
  result: EditResult;
}

function buildStructuredEditOutput(params: BuildStructuredEditOutputParams): EditOutput {
  const { validPath, size, lineCount, mimeType, kind, resourceUri, modified, result } = params;
  return {
    ok: true as const,
    path: validPath,
    size,
    lineCount,
    mimeType,
    kind,
    resourceUri,
    modified,
    ...(result.appliedEdits > 0
      ? {
          appliedEdits: result.appliedEdits,
          linesAdded: result.linesAdded,
          linesRemoved: result.linesRemoved,
        }
      : { appliedEdits: 0 }),
    ...(result.unmatchedEdits.length > 0 ? { unmatchedEdits: result.unmatchedEdits } : {}),
    ...(result.diff ? { diff: result.diff } : {}),
    ...(result.lineRange ? { lineRange: result.lineRange } : {}),
  };
}

async function finalizeEditResult(
  originalContent: string,
  updatedContent: string,
  appliedEdits: number,
  unmatchedEdits: string[],
  lineRange: EditResult['lineRange'],
): Promise<EditResult> {
  const { linesAdded, linesRemoved } =
    appliedEdits > 0
      ? await computeDiffStats(originalContent, updatedContent)
      : { linesAdded: 0, linesRemoved: 0 };

  return {
    content: updatedContent,
    appliedEdits,
    unmatchedEdits,
    linesAdded,
    linesRemoved,
    ...(lineRange ? { lineRange } : {}),
  };
}

interface EditFileMetadata {
  bytesWritten: number;
  lineCount: number;
  mimeType: string;
  kind: 'text' | 'binary' | 'image' | 'audio' | 'pdf';
  resourceUri: string;
  resourceLink: ContentBlock | undefined;
}

function buildEditFileMetadata(
  content: string,
  validPath: string,
  appliedEdits: number,
  resourceStore: ResourceStore | undefined,
): EditFileMetadata {
  const bytesWritten = Buffer.byteLength(content, 'utf-8');
  const lineCount = content.split('\n').length;
  const mimeInfo = detectMimeType(validPath, Buffer.from(content.slice(0, MIME_SAMPLE_SIZE)));
  const resourceUri =
    appliedEdits > 0 ? `filesystem-mcp://file/${validPath.replace(/\\/g, '/')}` : '';
  let resourceLink: ContentBlock | undefined;
  if (appliedEdits > 0 && resourceStore) {
    resourceLink = {
      type: 'resource_link',
      uri: resourceUri,
      name: basename(validPath),
      mimeType: mimeInfo.mimeType,
      size: bytesWritten,
      annotations: { audience: ['user', 'assistant'] },
    };
  }
  return {
    bytesWritten,
    lineCount,
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    resourceUri,
    resourceLink,
  };
}

async function buildDiff(validPath: string, original: string, modified: string): Promise<string> {
  const fileName = basename(validPath);
  const totalBytes = Buffer.byteLength(original) + Buffer.byteLength(modified);
  if (shouldOffload(totalBytes)) {
    return await runInWorker('createPatch', {
      oldStr: original,
      newStr: modified,
      oldHeader: fileName,
      newHeader: fileName,
    });
  }
  return new Promise<string>((resolve) => {
    setImmediate(() => {
      createTwoFilesPatch(fileName, fileName, original, modified, 'Original', 'Modified', {
        callback: (res: string | undefined) => {
          resolve(res ?? '');
        },
      });
    });
  });
}

async function loadEditableFile(
  requestedPath: string,
  pathGuard: PathGuard,
  signal?: AbortSignal,
): Promise<{ validPath: string; content: string }> {
  const { stats, validPath } = await stat(
    requestedPath,
    pathGuard,
    signal ? { signal } : undefined,
  );

  if (stats.size > MAX_TEXT_FILE_SIZE) {
    throw new McpError(
      ErrorCode.TOO_LARGE,
      `File too large for edit (${stats.size} bytes > ${MAX_TEXT_FILE_SIZE} bytes)`,
      requestedPath,
      { size: stats.size, maxFileSize: MAX_TEXT_FILE_SIZE },
    );
  }

  const { content } = await readFileWithStats(
    requestedPath,
    validPath,
    stats,
    {
      encoding: 'utf-8',
      maxSize: MAX_TEXT_FILE_SIZE,
      skipBinary: true,
      ...(signal ? { signal } : {}),
    },
    pathGuard,
  );
  return { validPath, content };
}

async function applyEdits(
  content: string,
  edits: z.infer<typeof EditSpecSchema>[],
  ignoreWhitespace: boolean,
): Promise<EditResult> {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];
  let lineRange: EditResult['lineRange'];
  const regexCache = ignoreWhitespace ? new Map<string, RE2>() : undefined;

  for (const edit of edits) {
    const match = findEditMatch(newContent, edit.oldText, ignoreWhitespace, regexCache);

    if (!match) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    lineRange = mergeLineRange(lineRange, newContent, match.startIndex, edit.newText);
    newContent = replaceEditMatch(newContent, match, edit.newText);
    appliedEdits += 1;
  }

  return finalizeEditResult(content, newContent, appliedEdits, unmatchedEdits, lineRange);
}

async function handleEditFile(
  filePath: string,
  edits: z.infer<typeof EditSpecSchema>[],
  dryRun: boolean,
  ignoreWhitespace: boolean,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<{
  structured: EditOutput;
  editedContent: string;
  validPath: string;
  resourceLink?: ContentBlock;
}> {
  const { validPath, content } = await loadEditableFile(filePath, pathGuard, signal);
  const editResult = await applyEdits(content, edits, ignoreWhitespace);

  if (dryRun) {
    if (editResult.appliedEdits > 0) {
      editResult.diff = await buildDiff(validPath, content, editResult.content);
    }

    const meta = buildEditFileMetadata(
      editResult.content,
      validPath,
      editResult.appliedEdits,
      resourceStore,
    );
    return {
      structured: buildStructuredEditOutput({
        validPath,
        size: meta.bytesWritten,
        lineCount: meta.lineCount,
        mimeType: meta.mimeType,
        kind: meta.kind,
        resourceUri: meta.resourceUri,
        modified: new Date().toISOString(),
        result: editResult,
      }),
      editedContent: editResult.content,
      validPath,
      ...(meta.resourceLink ? { resourceLink: meta.resourceLink } : {}),
    };
  }

  if (editResult.appliedEdits === 0 && editResult.unmatchedEdits.length > 0) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      `All ${editResult.unmatchedEdits.length} edits failed. Verify oldText matches exact file content.`,
      filePath,
    );
  }

  if (editResult.appliedEdits > 0) {
    await atomicWriteFile(filePath, editResult.content, pathGuard, {
      encoding: 'utf-8',
      signal,
    });
    // In case the path changed due to case sensitivity, though unlikely.
    /* validPath handled by atomicWriteFile */
    Logger.info(
      `edit: ${filePath} (${editResult.appliedEdits} edits, +${editResult.linesAdded}/-${editResult.linesRemoved})`,
    );
  }

  const { stats: fileStats } = await stat(filePath, pathGuard, signal ? { signal } : undefined);
  const meta = buildEditFileMetadata(
    editResult.content,
    validPath,
    editResult.appliedEdits,
    resourceStore,
  );
  return {
    structured: buildStructuredEditOutput({
      validPath,
      size: meta.bytesWritten,
      lineCount: meta.lineCount,
      mimeType: meta.mimeType,
      kind: meta.kind,
      resourceUri: meta.resourceUri,
      modified: fileStats.mtime.toISOString(),
      result: editResult,
    }),
    editedContent: editResult.content,
    validPath,
    ...(meta.resourceLink ? { resourceLink: meta.resourceLink } : {}),
  };
}

type PerFileResult = z.infer<typeof PerFileResultSchema>;

function formatFileToken(res: PerFileResult): string {
  const base = basename(res.path);
  if (res.unmatchedEdits && res.unmatchedEdits.length > 0) return `${base} NO MATCH`;
  const added = res.linesAdded ?? 0;
  const removed = res.linesRemoved ?? 0;
  if (added === 0 && removed === 0) return `${base} (no change)`;
  return `${base} +${added} -${removed}`;
}

function formatFailedToken(path: string): string {
  return `${basename(path)} FAILED`;
}

function formatMultiSummary(
  results: PerFileResult[],
  failures: { path: string; error: z.infer<typeof PerFileErrorSchema> }[],
  dryRun: boolean,
): string {
  const tag = dryRun ? ' [dry run]' : '';
  const tokens = [
    ...results.map(formatFileToken),
    ...failures.map((f) => formatFailedToken(f.path)),
  ];
  const ratio =
    failures.length > 0 ? ` (${results.length}/${results.length + failures.length} ok)` : '';
  return `edit: ${tokens.join(' \u00b7 ')}${ratio}${tag}`;
}

interface EditJob {
  filePath: string;
  edits: z.infer<typeof EditSpecSchema>[];
}

function normalizeJobs(args: EditInput): EditJob[] {
  if (args.path !== undefined) {
    return [{ filePath: args.path, edits: args.edits ?? [] }];
  }
  if (args.paths !== undefined) {
    return args.paths.map((p) => ({ filePath: p, edits: args.edits ?? [] }));
  }
  // files mode
  return (args.files ?? []).map((f) => ({ filePath: f.path, edits: f.edits }));
}

type RunOneFileResult =
  | { kind: 'ok'; path: string; result: PerFileResult; link?: string }
  | { kind: 'failed'; path: string; error: z.infer<typeof PerFileErrorSchema> };

export async function runOneFile(
  filePath: string,
  edits: z.infer<typeof EditSpecSchema>[],
  dryRun: boolean,
  ignoreWhitespace: boolean,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal: AbortSignal,
): Promise<RunOneFileResult> {
  try {
    const { structured, resourceLink } = await handleEditFile(
      filePath,
      edits,
      dryRun,
      ignoreWhitespace,
      pathGuard,
      resourceStore,
      signal,
    );
    const result: PerFileResult = {
      path: structured.path ?? filePath,
      size: structured.size ?? 0,
      lineCount: structured.lineCount ?? 0,
      mimeType: structured.mimeType ?? 'application/octet-stream',
      kind: structured.kind ?? 'text',
      resourceUri: structured.resourceUri ?? '',
      modified: structured.modified ?? new Date().toISOString(),
      appliedEdits: structured.appliedEdits ?? 0,
      ...(structured.linesAdded !== undefined ? { linesAdded: structured.linesAdded } : {}),
      ...(structured.linesRemoved !== undefined ? { linesRemoved: structured.linesRemoved } : {}),
      ...(structured.diff !== undefined ? { diff: structured.diff } : {}),
      ...(structured.unmatchedEdits !== undefined
        ? { unmatchedEdits: structured.unmatchedEdits }
        : {}),
      ...(structured.lineRange !== undefined ? { lineRange: structured.lineRange } : {}),
    };
    return {
      kind: 'ok',
      path: filePath,
      result,
      ...(resourceLink && 'uri' in resourceLink ? { link: resourceLink.uri } : {}),
    };
  } catch (err: unknown) {
    return {
      kind: 'failed',
      path: filePath,
      error: Problem.fromUnknown(err, ErrorCode.UNKNOWN, filePath),
    };
  }
}

async function dispatch(args: EditInput, ctx: ToolCtx): Promise<RunResult<EditOutput>> {
  const jobs = normalizeJobs(args);
  const isSingle = jobs.length === 1 && args.path !== undefined;

  if (isSingle) {
    const filePath = args.path ?? '';
    const edits = args.edits ?? [];
    const { structured, resourceLink } = await handleEditFile(
      filePath,
      edits,
      args.dryRun,
      args.ignoreWhitespace,
      ctx.pathGuard,
      ctx.resourceStore,
      ctx.signal,
    );
    ctx.log?.('info', `edit: ${filePath} (${String(structured.appliedEdits ?? 0)} edits)`, 'edit');
    const summary =
      `edit: edited ${basename(filePath)}` +
      ` \u00b7 ${formatBytes(structured.size ?? 0)}` +
      ` \u00b7 ${String(structured.lineCount)} lines`;
    if (resourceLink) {
      return { structured, text: summary, resources: [resourceLink] };
    }
    return { structured, text: summary };
  }

  // Multi-file: run in parallel
  const { results: rawResults } = await processInParallel(
    jobs,
    (job) =>
      runOneFile(
        job.filePath,
        job.edits,
        args.dryRun,
        args.ignoreWhitespace,
        ctx.pathGuard,
        ctx.resourceStore,
        ctx.signal,
      ),
    PARALLEL_CONCURRENCY,
    ctx.signal,
  );

  const results: PerFileResult[] = [];
  const failures: { path: string; error: z.infer<typeof PerFileErrorSchema> }[] = [];

  for (const r of rawResults) {
    if (r.kind === 'ok') results.push(r.result);
    else failures.push({ path: r.path, error: r.error });
  }

  const summaryText = formatMultiSummary(results, failures, args.dryRun);
  const structured: EditOutput = {
    ok: true,
    results,
    ...(failures.length > 0 ? { failures } : {}),
    summary: {
      total: jobs.length,
      succeeded: results.length,
      failed: failures.length,
    },
  };

  const links: ContentBlock[] = rawResults
    .filter(
      (r): r is Extract<RunOneFileResult, { kind: 'ok' }> & { link: string } =>
        r.kind === 'ok' && r.link !== undefined,
    )
    .map((r) => ({ type: 'resource_link' as const, uri: r.link, name: r.link }));

  return {
    structured,
    text: summaryText,
    ...(links.length > 0 ? { resources: links } : {}),
  };
}

export const EDIT = defineTool({
  name: 'edit',
  title: 'Edit Files',
  description:
    'Apply sequential literal string replacements to one or more files (max 5). ' +
    'Single-file: { path, edits }. Multi-file shared: { paths, edits } — same edits applied to each file. ' +
    'Multi-file per-file: { files: [{ path, edits }, \u2026] }. ' +
    '`oldText` must match exactly — include 3\u20135 lines of context. ' +
    'Use `dryRun:true` to preview. For glob-driven bulk regex replacement, use `replace_text` instead.',
  input: EditFileInputSchema,
  output: EditFileOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  nuances: ['Each edit applies to the output of the previous edit.'],
  progress: (args) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    let subject: string;
    if (args.path !== undefined) {
      subject = basename(args.path);
    } else if (args.paths !== undefined) {
      subject = `${args.paths.length} files`;
    } else if (args.files !== undefined) {
      subject = `${args.files.length} files`;
    } else {
      subject = 'files';
    }
    return { label: `Edit${dryLabel}`, subject };
  },
  run: async (args, ctx) => dispatch(args, ctx),
});
