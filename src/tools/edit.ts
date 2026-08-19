import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';
import { createTwoFilesPatch, diffLines } from 'diff';

import { ErrorCode, FsError } from '../core/errors.js';
import { atomicWriteFile, countLines, readFileWithStats, stat } from '../core/fs.js';
import { detectMimeType, MIME_SAMPLE_SIZE } from '../core/mime.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import type { Regex } from '../core/search/engine.js';
import { compileRegex } from '../core/search/engine.js';
import type { ResourceStore } from '../core/store.js';
import { MAX_TEXT_FILE_SIZE } from '../core/util.js';
import {
  defaultFalseBoolean,
  FileKind,
  isBlank,
  IsoDateTime,
  NonNegInt,
  OperationSummarySchema,
  PerFileErrorSchema,
  PositiveInt,
  singleOrBatchPathsInput,
} from '../schema.js';
import { buildFileResourceLink, buildFileResourceUri } from './_helpers.js';
import { runOverPaths } from './batch.js';
import { defineTool } from './define.js';

const EditSpecSchema = z.strictObject({
  oldText: z
    .string()
    .min(1, 'oldText required')
    .refine((val) => !isBlank(val), {
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

type EditFileValue = z.infer<typeof PerFileResultSchema>;

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

async function computeDiffStats(
  original: string,
  modified: string,
): Promise<{ linesAdded: number; linesRemoved: number }> {
  return new Promise((resolve) => {
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
  });
}

function findEditMatch(
  content: string,
  oldText: string,
  ignoreWhitespace: boolean,
  regexCache?: Map<string, Regex>,
): TextRange | undefined {
  if (ignoreWhitespace) {
    // Make whitespace flexible (tolerate indentation/spacing differences)
    // without letting it cross line boundaries: a whitespace run that contains
    // a newline keeps at least one newline, so a single-line oldText cannot
    // match across a newline and a multi-line oldText cannot collapse onto one
    // line. Horizontal whitespace stays mandatory between word characters so
    // adjacent identifiers are not merged.
    const pattern = escapeRegexLiteral(oldText)
      .replace(/[^\S\n]*\n\s*/g, '[^\\S\\n]*\\n+[^\\S\\n]*')
      .replace(/(\w)[^\S\n]+(\w)/g, '$1[^\\S\\n]+$2')
      .replace(/[^\S\n]+/g, '[^\\S\\n]*');
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

/**
 * Compute the 1-indexed line range of changed lines in `modified` relative to
 * `original`, using a common-prefix/suffix line scan. This is a conservative
 * bound (it widens to cover independent changes between matching bookends), but
 * it is computed against the FINAL content so it is not skewed by earlier edits
 * inserting or removing lines — which the per-edit merge could not account for.
 */
function computeChangedLineRange(original: string, modified: string): [number, number] | undefined {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const minLen = Math.min(origLines.length, modLines.length);

  let firstChanged = -1;
  for (let i = 0; i < minLen; i++) {
    if (origLines[i] !== modLines[i]) {
      firstChanged = i;
      break;
    }
  }
  if (firstChanged === -1 && origLines.length === modLines.length) return undefined;
  if (firstChanged === -1) firstChanged = minLen; // pure append/trim at the tail

  let lastChangedMod = modLines.length - 1;
  let lastChangedOrig = origLines.length - 1;
  while (
    lastChangedMod > firstChanged &&
    lastChangedOrig >= 0 &&
    modLines[lastChangedMod] === origLines[lastChangedOrig]
  ) {
    lastChangedMod--;
    lastChangedOrig--;
  }

  return [firstChanged + 1, lastChangedMod + 1];
}

function buildEditFileValue(
  validPath: string,
  meta: EditFileMetadata,
  modified: string,
  result: EditResult,
): EditFileValue {
  return {
    path: validPath,
    size: meta.bytesWritten,
    lineCount: meta.lineCount,
    mimeType: meta.mimeType,
    kind: meta.kind,
    resourceUri: meta.resourceUri,
    modified,
    appliedEdits: result.appliedEdits,
    ...(result.appliedEdits > 0
      ? { linesAdded: result.linesAdded, linesRemoved: result.linesRemoved }
      : {}),
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
  const lineCount = countLines(content);
  const mimeInfo = detectMimeType(validPath, Buffer.from(content.slice(0, MIME_SAMPLE_SIZE)));
  const resourceUri = appliedEdits > 0 ? buildFileResourceUri(validPath) : '';
  const resourceLink =
    appliedEdits > 0 && resourceStore
      ? buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten)
      : undefined;
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
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `File too large for edit (${stats.size} bytes > ${MAX_TEXT_FILE_SIZE} bytes)`,
      requestedPath,
      { size: stats.size, maxFileSize: MAX_TEXT_FILE_SIZE },
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
): Promise<EditResult> {
  let newContent = content;
  let appliedEdits = 0;
  const unmatchedEdits: string[] = [];
  const regexCache = ignoreWhitespace ? new Map<string, Regex>() : undefined;

  for (const edit of edits) {
    const match = findEditMatch(newContent, edit.oldText, ignoreWhitespace, regexCache);

    if (!match) {
      unmatchedEdits.push(edit.oldText);
      continue;
    }

    newContent = replaceEditMatch(newContent, match, edit.newText);
    appliedEdits += 1;
  }

  // Compute the line range against the final content so earlier edits whose
  // lines were shifted by later edits are still covered.
  const lineRange = appliedEdits > 0 ? computeChangedLineRange(content, newContent) : undefined;

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
): Promise<{ value: EditFileValue; resourceLink?: ContentBlock }> {
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
      value: buildEditFileValue(validPath, meta, new Date().toISOString(), editResult),
      ...(meta.resourceLink ? { resourceLink: meta.resourceLink } : {}),
    };
  }

  if (editResult.unmatchedEdits.length > 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `${editResult.unmatchedEdits.length} edit(s) failed to match. Verify oldText matches exact file content.`,
      filePath,
    );
  }

  if (editResult.appliedEdits > 0) {
    await atomicWriteFile(filePath, editResult.content, pathGuard, {
      encoding: 'utf-8',
      signal,
    });
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
    value: buildEditFileValue(validPath, meta, fileStats.mtime.toISOString(), editResult),
    ...(meta.resourceLink ? { resourceLink: meta.resourceLink } : {}),
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
      { value: EditFileValue; resourceLink?: ContentBlock }
    >(
      batchInput,
      ctx,
      ({ path, override }) =>
        handleEditFile(
          path,
          override?.edits ?? sharedEdits,
          args.dryRun,
          args.ignoreWhitespace,
          ctx.pathGuard,
          ctx.resourceStore,
          ctx.signal,
        ),
      { defaultErrorCode: ErrorCode.UNKNOWN },
    );

    const perPathResults: z.infer<typeof EditPerPathSchema>[] = [];
    const resourceLinks: ContentBlock[] = [];
    for (const r of batch.results) {
      if ('error' in r) {
        perPathResults.push({ path: r.path, error: r.error });
        continue;
      }
      perPathResults.push({ path: r.path, value: r.value.value });
      if (r.value.resourceLink) resourceLinks.push(r.value.resourceLink);
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
