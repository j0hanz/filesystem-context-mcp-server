import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { createTwoFilesPatch } from 'diff';
import RE2 from 're2';
import { z } from 'zod/v4';

import { runWorkerOr } from '../core/concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, FsError, Problem } from '../core/errors.js';
import {
  atomicWriteFile,
  DEFAULT_EXCLUDE_PATTERNS,
  detectMimeType,
  globEntries,
  MIME_SAMPLE_SIZE,
  readFileBufferWithLimit,
  stat,
} from '../core/fs.js';
import { Logger } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import {
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  NonNegInt,
  OptionalPath,
  PerFileErrorSchema,
  SafeGlobPattern,
} from '../schema.js';
import { truncateProgressPattern } from './_helpers.js';
import { defineTool } from './define.js';

function globEscape(name: string): string {
  return name.replace(/[*?[\]{}()!|+@\\]/g, '\\$&');
}

const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe('File glob filter (default: **/* text files)'),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .describe('Text or regex to find (RE2: no lookahead/lookbehind/backrefs when isRegex=true)')
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  replacement: z
    .string()
    .max(10000)
    .describe('Replacement text')
    .meta({ examples: ['$1_renamed', '', 'TODO: fix'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as regex'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Case-sensitive'),
  wholeWord: defaultFalseBoolean('Match whole words only'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preview changes without writing (default false = apply changes)'),
  returnDiff: defaultFalseBoolean('Include unified diff in output'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Max matches across all files'),
  maxFiles: z.uint32().min(1).max(MAX_SEARCH_RESULTS).optional().describe('Max files to process'),
  maxDepth: z.uint32().min(0).max(MAX_SEARCH_DEPTH).optional().describe('Max directory depth'),
});

const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  filesModified: NonNegInt.describe('Files changed'),
  totalMatches: NonNegInt.describe('Total match count'),
  processedFiles: NonNegInt.describe('Files scanned'),
  failedFiles: NonNegInt.optional().describe('Files that failed'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      }),
    )
    .optional()
    .describe('Per-file failures'),
  primaryFile: z
    .strictObject({
      path: z.string(),
      size: NonNegInt,
      lineCount: NonNegInt,
      mimeType: z.string(),
      kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']),
      resourceUri: z.string(),
    })
    .optional()
    .describe('Primary file with resource link'),
  results: z
    .array(z.strictObject({ path: z.string(), matches: NonNegInt }))
    .optional()
    .describe('Changed files with match counts'),
  resultsTruncated: z.boolean().optional().describe('results list was truncated'),
  diff: z.string().optional().describe('Unified diff (when returnDiff or dryRun)'),
  diffTruncated: z.boolean().optional().describe('Diff was truncated'),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe('Why enumeration stopped early'),
});

const MAX_FAILURES = 20;
const REPLACE_CONCURRENCY = Math.min(PARALLEL_CONCURRENCY, 8);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output
const DIFF_APPEND_BUFFER = 1024;

interface Failure {
  path: string;
  error: NonNullable<z.infer<typeof SearchAndReplaceOutputSchema>['failures']>[number]['error'];
}

function recordFailure(failures: Failure[], failure: Failure): void {
  if (failures.length >= MAX_FAILURES) return;
  failures.push(failure);
}

function recordChangedFile(summary: ReplaceSummary, filePath: string, matchCount: number): void {
  const relativePath = relative(summary.root, filePath);
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ path: relativePath, matches: matchCount });
    return;
  }
  summary.changedFilesTruncated = true;
}

function createRegexMatcher(pattern: string, caseSensitive: boolean): RE2 {
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RE2(pattern, flags);
  } catch (error) {
    throw new FsError(
      ErrorCode.INVALID_PATTERN,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`,
    );
  }
}

interface ReplacementMatcher {
  count(content: string): number;
  replace(content: string, replacement: string): string;
  testBuffer?(buffer: Buffer): boolean;
}

function createRegexReplacementMatcher(regex: RE2): ReplacementMatcher {
  return {
    testBuffer(buffer: Buffer): boolean {
      return regex.test(buffer);
    },
    count(content: string): number {
      regex.lastIndex = 0;
      let matchCount = 0;
      while (regex.exec(content) !== null) {
        matchCount++;
        if (regex.lastIndex === 0) {
          regex.lastIndex++;
        }
      }
      return matchCount;
    },
    replace(content: string, replacement: string): string {
      regex.lastIndex = 0;
      return content.replace(regex, replacement);
    },
  };
}

function createLiteralReplacementMatcher(
  searchPattern: string,
  caseSensitive: boolean,
): ReplacementMatcher {
  const patternLength = searchPattern.length;
  const searchBuffer = caseSensitive ? Buffer.from(searchPattern, 'utf8') : null;

  return {
    testBuffer(buffer: Buffer): boolean {
      if (!searchBuffer) return true;
      return buffer.indexOf(searchBuffer) !== -1;
    },
    count(content: string): number {
      let matchCount = 0;
      let pos = content.indexOf(searchPattern);
      while (pos !== -1) {
        matchCount++;
        pos = content.indexOf(searchPattern, pos + patternLength);
      }
      return matchCount;
    },
    replace(content: string, replacement: string): string {
      return content.replaceAll(searchPattern, () => replacement);
    },
  };
}

type SearchAndReplaceArgs = z.infer<typeof SearchAndReplaceInputSchema>;
type SearchAndReplaceOutput = z.infer<typeof SearchAndReplaceOutputSchema>;

interface ReplaceContext {
  options: { dryRun: boolean; returnDiff: boolean };
  replacement: string;
  matcher: ReplacementMatcher;
  maxFileSize: number;
  signal: AbortSignal | undefined;
  summary: ReplaceSummary;
  pathGuard: PathGuard;
}

interface ReplacementPlan {
  matchCount: number;
  originalContent: string;
  updatedContent: string;
}

function buildReplacementPlan(
  content: string,
  replacement: string,
  matcher: ReplacementMatcher,
): ReplacementPlan | undefined {
  const matchCount = matcher.count(content);
  if (matchCount === 0) {
    return undefined;
  }

  return {
    matchCount,
    originalContent: content,
    updatedContent: matcher.replace(content, replacement),
  };
}

async function processEntry(entryPath: string, ctx: ReplaceContext): Promise<void> {
  const { options, signal, summary } = ctx;
  const validPath = entryPath;

  try {
    const plan = await readReplacementPlan(validPath, ctx);
    if (!plan) {
      return;
    }

    summary.totalMatches += plan.matchCount;
    summary.filesChanged++;

    recordChangedFile(summary, validPath, plan.matchCount);

    await maybeAppendPatchDiff(summary, {
      filePath: validPath,
      originalContent: plan.originalContent,
      updatedContent: plan.updatedContent,
      includeDiff: options.dryRun || options.returnDiff,
      ...(signal ? { signal } : {}),
    });

    if (!options.dryRun) {
      await atomicWriteFile(entryPath, plan.updatedContent, ctx.pathGuard, {
        encoding: 'utf-8',
        signal,
      });
    }
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: validPath,
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, validPath),
    });
  }
}

async function readReplacementPlan(
  validPath: string,
  ctx: ReplaceContext,
): Promise<ReplacementPlan | undefined> {
  const { matcher, replacement, maxFileSize, signal } = ctx;
  await using fileHandle = await open(validPath, 'r');
  const { stats } = await stat(
    validPath,
    ctx.pathGuard,
    ctx.signal ? { signal: ctx.signal } : undefined,
  );
  if (stats.size > maxFileSize) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
    );
  }

  let content: string;
  if (matcher.testBuffer) {
    const buffer = await readFileBufferWithLimit(fileHandle, maxFileSize, validPath, signal);
    if (!matcher.testBuffer(buffer)) return undefined;
    content = buffer.toString('utf-8');
  } else {
    const buffer = await readFileBufferWithLimit(fileHandle, maxFileSize, validPath, signal);
    content = buffer.toString('utf-8');
  }

  return buildReplacementPlan(content, replacement, matcher);
}

async function maybeAppendPatchDiff(
  summary: ReplaceSummary,
  params: {
    filePath: string;
    originalContent: string;
    updatedContent: string;
    includeDiff: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (!params.includeDiff) return;
  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

  const header = basename(params.filePath);
  const totalBytes =
    Buffer.byteLength(params.originalContent) + Buffer.byteLength(params.updatedContent);

  const patch = await runWorkerOr(
    'createPatch',
    {
      oldStr: params.originalContent,
      newStr: params.updatedContent,
      oldHeader: header,
      newHeader: header,
    },
    totalBytes,
    params.signal ? { signal: params.signal } : {},
    () =>
      new Promise<string>((resolve) => {
        // Defer to event loop to avoid blocking on large diffs
        setImmediate(() => {
          createTwoFilesPatch(
            header,
            header,
            params.originalContent,
            params.updatedContent,
            'Original',
            'Modified',
            {
              callback: (res: string | undefined) => {
                resolve(res ?? '');
              },
            },
          );
        });
      }),
  );

  if (summary.diff.length + patch.length <= MAX_DIFF_SIZE + DIFF_APPEND_BUFFER) {
    summary.diff += patch;
    return;
  }

  summary.diffTruncated = true;
}

async function processEntriesConcurrently(
  entries: AsyncIterable<{ path: string }>,
  options: {
    signal: AbortSignal | undefined;
    concurrency: number;
    maxEntries?: number;
    shouldStop?: () => boolean;
    onEntry: () => void;
    runEntry: (entryPath: string) => Promise<void>;
  },
): Promise<{ stoppedByLimit: boolean; stoppedByMatchCap: boolean }> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, maxEntries, shouldStop, onEntry, runEntry } = options;
  let dispatched = 0;
  let stoppedByLimit = false;
  let stoppedByMatchCap = false;

  const waitForSlot = async (): Promise<void> => {
    if (pending.size < concurrency) return;
    await Promise.race(pending);
  };

  for await (const entry of entries) {
    if (signal?.aborted) break;
    if (maxEntries !== undefined && dispatched >= maxEntries) {
      stoppedByLimit = true;
      break;
    }
    await waitForSlot();
    if (shouldStop?.()) {
      stoppedByMatchCap = true;
      break;
    }
    onEntry();
    dispatched++;

    const task = runEntry(entry.path);
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
    });
  }

  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }

  return { stoppedByLimit, stoppedByMatchCap };
}

interface ReplaceSummary {
  root: string;
  totalMatches: number;
  filesChanged: number;
  failedFiles: number;
  processedFiles: number;
  failures: Failure[];
  changedFiles: { path: string; matches: number }[];
  changedFilesTruncated: boolean;
  diff: string;
  diffTruncated: boolean;
  stoppedReason?: 'maxFiles' | 'maxResults';
  perfTimeMs?: number;
}

function createReplaceSummary(root: string): ReplaceSummary {
  return {
    root,
    totalMatches: 0,
    filesChanged: 0,
    failedFiles: 0,
    processedFiles: 0,
    failures: [],
    changedFiles: [],
    changedFilesTruncated: false,
    diff: '',
    diffTruncated: false,
  };
}

async function resolveSearchRoot(
  pathValue: string | undefined,
  pathGuard: PathGuard,
): Promise<{ root: string; filePattern: string | undefined }> {
  if (!pathValue) {
    return { root: pathGuard.resolvePathOrRoot(undefined), filePattern: undefined };
  }
  const resolvedPath = await pathGuard.validateExistingPath(pathValue);
  const { stats: fileStats } = await stat(resolvedPath, pathGuard);
  if (fileStats.isFile()) {
    return { root: dirname(resolvedPath), filePattern: globEscape(basename(resolvedPath)) };
  }
  return { root: resolvedPath, filePattern: undefined };
}

function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchPattern(args: SearchAndReplaceArgs): string {
  if (args.isRegex) {
    return args.wholeWord ? `\\b(?:${args.searchPattern})\\b` : args.searchPattern;
  }
  const escaped = escapeRegex(args.searchPattern);
  return args.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
}

function createReplacementMatcher(args: SearchAndReplaceArgs): ReplacementMatcher {
  // Use regex when isRegex, wholeWord, or case-insensitive (all require RE2)
  if (args.isRegex || args.wholeWord || !args.caseSensitive) {
    const pattern = buildSearchPattern(args);
    const regex = createRegexMatcher(pattern, args.caseSensitive);
    return createRegexReplacementMatcher(regex);
  }
  return createLiteralReplacementMatcher(args.searchPattern, args.caseSensitive);
}

async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  onProgress: (progress: { total?: number; current: number }) => void = () => undefined,
  resourceStore?: ResourceStore,
): Promise<{
  structured: SearchAndReplaceOutput;
  link?: ContentBlock;
}> {
  const maxFileSize = MAX_TEXT_FILE_SIZE;
  const { root, filePattern } = await resolveSearchRoot(args.path, pathGuard);
  const effectivePattern = filePattern ?? args.pattern ?? '**/*';
  const matcher = createReplacementMatcher(args);

  const entries = globEntries({
    cwd: root,
    pattern: effectivePattern,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    includeHidden: args.includeHidden,
    baseNameMatch: true,
    caseSensitiveMatch: true, // Default to sensitive for file paths
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: false,
    suppressErrors: true,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
  });

  const summary = createReplaceSummary(root);

  const t0 = performance.now();

  const context: ReplaceContext = {
    options: {
      dryRun: args.dryRun,
      returnDiff: args.returnDiff,
    },
    replacement: args.replacement,
    matcher,
    maxFileSize,
    signal,
    summary,
    pathGuard,
  };

  const { stoppedByLimit, stoppedByMatchCap } = await processEntriesConcurrently(entries, {
    signal,
    concurrency: REPLACE_CONCURRENCY,
    ...(args.maxFiles !== undefined ? { maxEntries: args.maxFiles } : {}),
    shouldStop: () => summary.totalMatches >= args.maxResults,
    onEntry: () => {
      summary.processedFiles++;
      onProgress({ current: summary.processedFiles });
    },
    runEntry: (entryPath) => processEntry(entryPath, context),
  });

  summary.perfTimeMs = performance.now() - t0;

  if (stoppedByLimit) {
    summary.stoppedReason = 'maxFiles';
  } else if (stoppedByMatchCap) {
    summary.stoppedReason = 'maxResults';
  }

  onProgress({ current: summary.processedFiles });

  if (!args.dryRun && summary.totalMatches > 0) {
    Logger.info(
      `search_and_replace: ${summary.filesChanged} file(s), ${summary.totalMatches} match(es)`,
    );
  }

  const structured = buildSearchAndReplaceStructuredResult(summary, args);

  // Store primary file in resource store if available
  if (resourceStore && summary.changedFiles.length > 0 && summary.filesChanged > 0) {
    const primaryFile = summary.changedFiles[0];
    if (!primaryFile) return { structured };

    const primaryFilePath = primaryFile.path;
    const fullPath = join(summary.root, primaryFilePath);

    try {
      const content = await (async (): Promise<string> => {
        const fd = await open(fullPath, 'r');
        try {
          const buffer = await readFileBufferWithLimit(fd, maxFileSize, fullPath, signal);
          return buffer.toString('utf-8');
        } finally {
          await fd.close();
        }
      })();

      const mimeInfo = detectMimeType(fullPath, Buffer.from(content.slice(0, MIME_SAMPLE_SIZE)));
      const lineCount = content.split('\n').length;
      const size = Buffer.byteLength(content, 'utf-8');

      const fileUri = `filesystem-mcp://file/${fullPath.replace(/\\/g, '/')}`;
      const link: ContentBlock = {
        type: 'resource_link',
        uri: fileUri,
        name: basename(fullPath),
        mimeType: mimeInfo.mimeType,
        size,
        annotations: { audience: ['user', 'assistant'] },
      };

      structured.primaryFile = {
        path: primaryFilePath,
        size,
        lineCount,
        mimeType: mimeInfo.mimeType,
        kind: mimeInfo.kind,
        resourceUri: fileUri,
      };

      return { structured, link };
    } catch (error) {
      // Gracefully fall back if resource storage fails
      Logger.error(
        `Failed to store primary file in resource store: ${formatUnknownErrorMessage(error)}`,
      );
    }
  }

  return { structured };
}

export const SEARCH_AND_REPLACE = defineTool({
  name: 'replace_text',
  title: 'Search and Replace',
  description:
    'Bulk search-and-replace across files matching a glob. ' +
    'Replaces ALL occurrences per file (unlike `edit`: first only). ' +
    'Use `returnDiff:true` to preview changes as a unified diff before or alongside writing. ' +
    'Literal matching by default; `isRegex:true` enables RE2 with capture groups ($1, $2).',
  input: SearchAndReplaceInputSchema,
  output: SearchAndReplaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: 'optional' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  gotchas: [
    'RE2 dialect: no lookahead, lookbehind, or backreferences.',
    'Replaces ALL occurrences per file; use `edit` for first-only replacement.',
    "Patterns without '/' match by filename anywhere in the tree (e.g. *.ts finds all .ts files). Add a path prefix like src/*.ts to restrict to a subtree.",
    'Passing a file path auto-scopes the search to that single file. To combine a directory scope with a glob filter, pass the directory as path and use the pattern field.',
  ],
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    return {
      label: `Replace${dryLabel}`,
      subject: `${truncateProgressPattern(args.searchPattern)} → ${truncateProgressPattern(args.replacement)}`,
    };
  },
  run: async (args, ctx) => {
    const truncatedPattern = truncateProgressPattern(args.searchPattern);
    const onProgress = (params: { current: number; total?: number }): void => {
      ctx.onProgress?.({
        current: params.current,
        ...(params.total !== undefined ? { total: params.total } : {}),
      });
    };
    const { structured, link } = await handleSearchAndReplace(
      args,
      ctx.pathGuard,
      ctx.signal,
      onProgress,
      ctx.resourceStore,
    );
    if (!args.dryRun) {
      ctx.log?.(
        'info',
        `search_and_replace: ${String(structured.totalMatches)} matches in ${String(structured.filesModified)} files`,
        'search_and_replace',
      );
    }
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    const summaryText =
      `search-and-replace: '${truncatedPattern}'${dryLabel}` +
      ` \u00b7 ${String(structured.totalMatches)} match(es)` +
      ` in ${String(structured.filesModified)} file(s)`;
    if (link) {
      return { structured, text: summaryText, resources: [link] };
    }
    return { structured, text: summaryText };
  },
});
function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  args: SearchAndReplaceArgs,
): SearchAndReplaceOutput {
  return {
    ok: true,
    filesModified: summary.filesChanged,
    totalMatches: summary.totalMatches,
    processedFiles: summary.processedFiles,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    ...(summary.failures.length > 0 ? { failures: summary.failures } : {}),
    ...(summary.changedFiles.length > 0 ? { results: summary.changedFiles } : {}),
    ...(summary.changedFilesTruncated ? { resultsTruncated: true } : {}),
    ...((args.dryRun || args.returnDiff) && summary.diff ? { diff: summary.diff } : {}),
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
  };
}
