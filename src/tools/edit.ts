import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import { createTwoFilesPatch, diffLines } from 'diff';
import RE2 from 're2';
import { z } from 'zod/v4';

import { runWorkerOr } from '../core/concurrency.js';
import { ErrorCode, FsError } from '../core/errors.js';
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
import { MAX_TEXT_FILE_SIZE } from '../core/util.js';
import {
  defaultFalseBoolean,
  IsoDateTime,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  singleOrBatchPathsInput,
} from '../schema.js';
import { defineTool, type PerPathResult, runOverPaths } from './define.js';

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

const MAX_MULTI_FILES = 5;

const EditFileInputSchema = singleOrBatchPathsInput({
  extra: {
    edits: z
      .array(EditSpecSchema)
      .min(1)
      .optional()
      .describe('Edits applied to path or every entry in paths (forbidden when using files)'),
    dryRun: defaultFalseBoolean('Preview changes without writing'),
    ignoreWhitespace: defaultFalseBoolean('Ignore leading/trailing whitespace when matching'),
  },
  perFile: {
    edits: z.array(EditSpecSchema).min(1).describe('Edits for this file'),
  },
  maxBatch: MAX_MULTI_FILES,
}).superRefine((value, ctx) => {
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

const EditPerPathSchema = z.strictObject({
  path: z.string().describe('Requested path'),
  value: PerFileResultSchema.optional().describe('Per-file edit result (success)'),
  error: PerFileErrorSchema.optional().describe('Per-path error'),
});

const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  results: z.array(EditPerPathSchema).describe('Per-path results (always present)'),
  summary: OperationSummarySchema.describe('Aggregate counts'),
});

interface SingleEditStructured {
  ok: true;
  path?: string;
  size?: number;
  lineCount?: number;
  mimeType?: string;
  kind?: 'text' | 'binary' | 'image' | 'audio' | 'pdf';
  resourceUri?: string;
  modified?: string;
  appliedEdits?: number;
  linesAdded?: number;
  linesRemoved?: number;
  diff?: string;
  unmatchedEdits?: string[];
  lineRange?: [number, number];
}

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
  signal?: AbortSignal,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  const totalBytes = Buffer.byteLength(original) + Buffer.byteLength(modified);
  return runWorkerOr(
    'computeDiffStats',
    { oldStr: original, newStr: modified },
    totalBytes,
    signal ? { signal } : {},
    () =>
      new Promise((resolve) => {
        // Yield to the event loop so we don't completely block
        setImmediate(() => {
          diffLines(original, modified, {
            callback: (changes) => {
              let linesAdded = 0;
              let linesRemoved = 0;
              for (const part of changes) {
                if (part.added) linesAdded += part.count;
                else if (part.removed) linesRemoved += part.count;
              }
              resolve({ linesAdded, linesRemoved });
            },
          });
        });
      }),
  );
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

function buildStructuredEditOutput(params: BuildStructuredEditOutputParams): SingleEditStructured {
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
  signal?: AbortSignal,
): Promise<EditResult> {
  const { linesAdded, linesRemoved } =
    appliedEdits > 0
      ? await computeDiffStats(originalContent, updatedContent, signal)
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

async function buildDiff(
  validPath: string,
  original: string,
  modified: string,
  signal?: AbortSignal,
): Promise<string> {
  const fileName = basename(validPath);
  const totalBytes = Buffer.byteLength(original) + Buffer.byteLength(modified);
  return runWorkerOr(
    'createPatch',
    { oldStr: original, newStr: modified, oldHeader: fileName, newHeader: fileName },
    totalBytes,
    signal ? { signal } : {},
    () =>
      new Promise<string>((resolve) => {
        setImmediate(() => {
          createTwoFilesPatch(fileName, fileName, original, modified, 'Original', 'Modified', {
            callback: (res: string | undefined) => {
              resolve(res ?? '');
            },
          });
        });
      }),
  );
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
    throw new FsError(
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
      kind: 'full',
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
  signal?: AbortSignal,
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

  return finalizeEditResult(content, newContent, appliedEdits, unmatchedEdits, lineRange, signal);
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
  structured: SingleEditStructured;
  editedContent: string;
  validPath: string;
  resourceLink?: ContentBlock;
}> {
  const { validPath, content } = await loadEditableFile(filePath, pathGuard, signal);
  const editResult = await applyEdits(content, edits, ignoreWhitespace, signal);

  if (dryRun) {
    if (editResult.appliedEdits > 0) {
      editResult.diff = await buildDiff(validPath, content, editResult.content, signal);
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
    throw new FsError(
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

function toEditPerPathPayload(
  r: PerPathResult<{
    structured: {
      ok: true;
      path?: string;
      size?: number;
      lineCount?: number;
      mimeType?: string;
      kind?: 'text' | 'binary' | 'image' | 'audio' | 'pdf';
      resourceUri?: string;
      modified?: string;
      appliedEdits?: number;
      linesAdded?: number;
      linesRemoved?: number;
      diff?: string;
      unmatchedEdits?: string[];
      lineRange?: [number, number];
    };
    resourceLink?: ContentBlock;
  }>,
): { perPath: z.infer<typeof EditPerPathSchema>; resourceLink?: ContentBlock } {
  if (r.error) {
    return { perPath: { path: r.path, error: r.error } };
  }

  const inner = r.value;
  if (!inner) {
    return {
      perPath: {
        path: r.path,
        error: { code: ErrorCode.UNKNOWN, message: 'Unknown edit failure', path: r.path },
      },
    };
  }

  const s = inner.structured;
  const value: z.infer<typeof PerFileResultSchema> = {
    path: s.path ?? r.path,
    size: s.size ?? 0,
    lineCount: s.lineCount ?? 0,
    mimeType: s.mimeType ?? 'application/octet-stream',
    kind: s.kind ?? 'text',
    resourceUri: s.resourceUri ?? '',
    modified: s.modified ?? new Date().toISOString(),
    appliedEdits: s.appliedEdits ?? 0,
    ...(s.linesAdded !== undefined ? { linesAdded: s.linesAdded } : {}),
    ...(s.linesRemoved !== undefined ? { linesRemoved: s.linesRemoved } : {}),
    ...(s.diff !== undefined ? { diff: s.diff } : {}),
    ...(s.unmatchedEdits !== undefined ? { unmatchedEdits: s.unmatchedEdits } : {}),
    ...(s.lineRange !== undefined ? { lineRange: s.lineRange } : {}),
  };

  return {
    perPath: { path: r.path, value },
    ...(inner.resourceLink ? { resourceLink: inner.resourceLink } : {}),
  };
}

function formatEditSummary(
  results: readonly z.infer<typeof EditPerPathSchema>[],
  dryRun: boolean,
): string {
  const tag = dryRun ? ' [dry run]' : '';
  const tokens = results.map((r) => {
    if (r.error) return `${basename(r.path)} FAILED`;
    const v = r.value;
    if (!v) return `${basename(r.path)} (no result)`;
    if (v.unmatchedEdits && v.unmatchedEdits.length > 0) return `${basename(v.path)} NO MATCH`;
    const added = v.linesAdded ?? 0;
    const removed = v.linesRemoved ?? 0;
    if (added === 0 && removed === 0) return `${basename(v.path)} (no change)`;
    return `${basename(v.path)} +${String(added)} -${String(removed)}`;
  });

  const failed = results.filter((r) => r.error !== undefined).length;
  const ok = results.length - failed;
  const ratio = failed > 0 ? ` (${String(ok)}/${String(results.length)} ok)` : '';
  return `edit: ${tokens.join(' · ')}${ratio}${tag}`;
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
  run: async (args, ctx) => {
    const sharedEdits = args.edits ?? [];
    const batchInput =
      args.path !== undefined
        ? { path: args.path }
        : args.paths !== undefined
          ? { paths: args.paths }
          : { files: args.files ?? [] };

    const batch = await runOverPaths<
      { edits: z.infer<typeof EditSpecSchema>[] },
      { structured: SingleEditStructured; resourceLink?: ContentBlock }
    >(
      batchInput,
      ctx,
      async ({ path, override }) => {
        const edits = override?.edits ?? sharedEdits;
        const { structured, resourceLink } = await handleEditFile(
          path,
          edits,
          args.dryRun,
          args.ignoreWhitespace,
          ctx.pathGuard,
          ctx.resourceStore,
          ctx.signal,
        );
        return resourceLink ? { structured, resourceLink } : { structured };
      },
      { defaultErrorCode: ErrorCode.UNKNOWN },
    );

    const perPathResults: z.infer<typeof EditPerPathSchema>[] = [];
    const resourceLinks: ContentBlock[] = [];
    for (const r of batch.results) {
      const { perPath, resourceLink } = toEditPerPathPayload(r);
      perPathResults.push(perPath);
      if (resourceLink) resourceLinks.push(resourceLink);
    }

    const summaryText = formatEditSummary(perPathResults, args.dryRun);

    return {
      structured: {
        ok: true as const,
        results: perPathResults,
        summary: batch.summary,
      },
      text: summaryText,
      ...(resourceLinks.length > 0 ? { resources: resourceLinks } : {}),
    };
  },
});
