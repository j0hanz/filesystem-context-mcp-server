import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';
import { createTwoFilesPatch, diffLines } from 'diff';

import { runWorkerOr } from '../core/concurrency.js';
import { ErrorCode, FsError, Problem } from '../core/errors.js';
import {
  atomicWriteFile,
  detectMimeType,
  MIME_SAMPLE_SIZE,
  readFileWithStats,
  stat,
} from '../core/fs.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import { compileRegex, type Regex } from '../core/search/engine.js';
import type { ResourceStore } from '../core/store.js';
import { MAX_TEXT_FILE_SIZE } from '../core/util.js';
import {
  defaultFalseBoolean,
  FileKind,
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
    .refine((val) => val.trim().length > 0, {
      message: 'oldText cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text to locate in the file. Must include 3-5 lines of context to ensure uniqueness and avoid matching the wrong block.',
    )
    .meta({ examples: ['const x = 1;', 'function oldName('] }),
  newText: z
    .string()
    .describe(
      'Replacement text. Use an empty string to delete the matched oldText. Cannot contain shell commands or malicious injection sequences.',
    )
    .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
});

const MAX_MULTI_FILES = 5;

const EditFileInputSchema = singleOrBatchPathsInput({
  extra: {
    edits: z
      .array(EditSpecSchema)
      .min(1)
      .optional()
      .describe(
        'Replacements applied to path or to every file in paths; not allowed when using files (each file carries its own edits)',
      ),
    dryRun: defaultFalseBoolean(
      'Preview diffs without writing to disk (default: false = apply edits)',
    ),
    ignoreWhitespace: defaultFalseBoolean(
      'Ignore leading/trailing whitespace differences when matching oldText',
    ),
  },
  perFile: {
    edits: z.array(EditSpecSchema).min(1).describe('Replacements to apply to this specific file'),
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
  path: z.string().describe('Resolved absolute path of the edited file'),
  size: NonNegInt.describe('File size in bytes after edits'),
  lineCount: NonNegInt.describe('Number of lines in the file after edits'),
  mimeType: z.string().describe('Detected MIME type of the file'),
  kind: FileKind.describe('Broad file kind: text, binary, image, audio, or pdf'),
  resourceUri: z.string().describe('Resource URI pointing to the updated file content'),
  modified: IsoDateTime.describe('Last modification timestamp after edits (ISO 8601 UTC)'),
  appliedEdits: NonNegInt.describe('Number of edits successfully applied'),
  linesAdded: NonNegInt.optional().describe('Net lines added by all applied edits'),
  linesRemoved: NonNegInt.optional().describe('Net lines removed by all applied edits'),
  diff: z
    .string()
    .optional()
    .describe('Unified diff of all changes (present in dryRun mode or when changes were made)'),
  unmatchedEdits: z
    .array(z.string())
    .optional()
    .describe('oldText values that did not match any content in the file'),
  lineRange: z
    .tuple([PositiveInt, PositiveInt])
    .optional()
    .describe('Line range [firstLine, lastLine] covering all applied edits'),
});

const EditPerPathSchema = z.strictObject({
  path: z.string().describe('The requested file path'),
  value: PerFileResultSchema.optional().describe('Edit result; present on success'),
  error: PerFileErrorSchema.optional().describe('Error details; present on failure'),
});

const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-file errors are reported in results[].error'),
  results: z
    .array(EditPerPathSchema)
    .describe('Per-path edit results ordered to match the input paths'),
  summary: OperationSummarySchema.describe('Aggregate counts: total, succeeded, failed'),
});

interface SingleEditStructured {
  ok: true;
  path?: string;
  size?: number;
  lineCount?: number;
  mimeType?: string;
  kind?: FileKind;
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
  regexCache?: Map<string, Regex>,
): TextRange | undefined {
  if (ignoreWhitespace) {
    const pattern = escapeRegexLiteral(oldText)
      .replace(/(\w)\s+(\w)/g, '$1\\s+$2')
      .replace(/\s+/g, '\\s*');
    let regex = regexCache?.get(pattern);
    if (!regex) {
      regex = compileRegex(pattern, { caseSensitive: true });
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
  kind: FileKind;
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
  kind: FileKind;
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
      Problem.tooLarge(
        `File too large for edit (${stats.size} bytes > ${MAX_TEXT_FILE_SIZE} bytes)`,
        {
          path: requestedPath,
          details: { extra: { size: stats.size, maxFileSize: MAX_TEXT_FILE_SIZE } },
        },
      ),
    );
  }

  const { content } = await readFileWithStats(requestedPath, validPath, stats, {
    kind: 'full',
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
    ...(signal ? { signal } : {}),
  });
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
  const regexCache = ignoreWhitespace ? new Map<string, Regex>() : undefined;

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

  if (editResult.unmatchedEdits.length > 0) {
    throw new FsError(
      Problem.invalidInput(
        `${editResult.unmatchedEdits.length} edit(s) failed to match. Verify oldText matches exact file content.`,
        { path: filePath },
      ),
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

  // `modified` is read from a post-write stat and is advisory: under a concurrent
  // writer it may reflect that writer's mtime while `size`/content below come from
  // this edit's atomic write. The file content itself is always consistent.
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
    structured: SingleEditStructured;
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
    'Apply sequential literal string replacements to one or more files (max 5 files per call). ' +
    'Modes: single-file { path, edits }, multi-file shared edits { paths, edits } (same edits on each file), or per-file { files: [{ path, edits }] }. ' +
    'oldText must match file content exactly; include 3-5 lines of surrounding context to ensure uniqueness. ' +
    'Set dryRun=true to preview diffs without writing. ' +
    'For glob-based bulk regex replacement across many files, use replace_text instead.',
  input: EditFileInputSchema,
  output: EditFileOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  nuances: [
    'Edits are applied sequentially: each edit operates on the result of the previous one.',
  ],
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
