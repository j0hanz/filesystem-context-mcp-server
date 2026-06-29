import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer } from 'node:buffer';

import * as z from 'zod/v4';
import { createTwoFilesPatch } from 'diff';

import { runWorkerOr } from '../core/concurrency.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isAbortError,
  Problem,
} from '../core/errors.js';
import { truncateProgressPattern } from '../core/fmt.js';
import {
  atomicWriteFile,
  DEFAULT_EXCLUDE_PATTERNS,
  detectMimeType,
  globEntries,
  type GuardedFileSystem,
  MIME_SAMPLE_SIZE,
  readFileBufferWithLimit,
  stat,
} from '../core/fs.js';
import { Logger } from '../core/observability.js';
import { PathFormatter } from '../core/path-formatter.js';
import type { PathGuard } from '../core/path.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import type { Regex } from '../core/search/engine.js';
import { compileRegex } from '../core/search/engine.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import {
  defaultFalseBoolean,
  FileKind,
  includeHiddenField,
  includeIgnoredField,
  isBlank,
  maxDepthField,
  NonNegInt,
  OptionalPath,
  PerFileErrorSchema,
  SafeGlobPattern,
} from '../schema.js';
import { defineTool } from './define.js';

function globEscape(name: string): string {
  return name.replace(/[*?[\]{}()!|+@\\]/g, '\\$&');
}

const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict replacements to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => !isBlank(val), {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text or RE2 regex pattern to search for. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences are supported). Cannot be empty or whitespace-only.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  replacement: z
    .string()
    .max(10000)
    .describe(
      'Replacement text. Use capture group references ($1, $2, etc.) when isRegex=true. Use an empty string to delete all matches. Cannot contain shell commands or malicious injection sequences.',
    )
    .meta({ examples: ['$1_renamed', '', 'TODO: fix'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as a RE2 regex (default: literal text match)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  wholeWord: defaultFalseBoolean('Match whole words only (word boundary anchoring)'),
  dryRun: defaultFalseBoolean(
    'Preview replacements without writing to disk (default: false = apply changes)',
  ),
  returnDiff: defaultFalseBoolean('Include a unified diff of all changes in the response'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Maximum total match count across all files before stopping'),
  maxFiles: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe('Maximum number of files to process'),
  maxDepth: maxDepthField(),
});

const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-file errors are in failures[]'),
  filesModified: NonNegInt.describe('Number of files that had at least one replacement applied'),
  totalMatches: NonNegInt.describe('Total number of replacements made across all files'),
  processedFiles: NonNegInt.describe('Total number of files examined'),
  failedFiles: NonNegInt.optional().describe('Number of files that could not be processed'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      }),
    )
    .optional()
    .describe('Per-file error details for files that could not be processed'),
  primaryFile: z
    .strictObject({
      path: z.string(),
      size: NonNegInt,
      lineCount: NonNegInt,
      mimeType: z.string(),
      kind: FileKind,
      resourceUri: z.string(),
    })
    .optional()
    .describe('Metadata for the first modified file including its resource URI'),
  results: z
    .array(z.strictObject({ path: z.string(), matches: NonNegInt }))
    .optional()
    .describe('List of modified files with their replacement counts'),
  resultsTruncated: z
    .boolean()
    .optional()
    .describe('True when the results list was cut due to the MAX_CHANGED_FILES cap'),
  diff: z
    .string()
    .optional()
    .describe('Unified diff of all changes (present when returnDiff=true or dryRun=true)'),
  diffTruncated: z
    .boolean()
    .optional()
    .describe('True when the diff was cut due to the size limit'),
  stoppedReason: z
    .enum(['maxResults', 'maxFiles', 'timeout'])
    .optional()
    .describe(
      'Why enumeration stopped early: maxResults = match cap reached, maxFiles = file cap reached, timeout = time limit hit',
    ),
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
  const relativePath = PathFormatter.relative(summary.root, filePath);
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ path: relativePath, matches: matchCount });
    return;
  }
  summary.changedFilesTruncated = true;
}

function createRegexMatcher(pattern: string, caseSensitive: boolean): Regex {
  return compileRegex(pattern, { caseSensitive });
}

interface ReplacementMatcher {
  count(content: string): number;
  replace(content: string, replacement: string): string;
  testBuffer?(buffer: Buffer): boolean;
}

function createRegexReplacementMatcher(regex: Regex): ReplacementMatcher {
  return {
    testBuffer(buffer: Buffer): boolean {
      return regex.test(buffer.toString('utf-8'));
    },
    count(content: string): number {
      regex.lastIndex = 0;
      let matchCount = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(content)) !== null) {
        matchCount++;
        if (m[0].length === 0) regex.lastIndex++;
      }
      return matchCount;
    },
    replace(content: string, replacement: string): string {
      regex.lastIndex = 0;
      return content.replace(regex, replacement);
    },
  };
}

function createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher {
  const patternLength = searchPattern.length;
  const searchBuffer = Buffer.from(searchPattern, 'utf8');

  return {
    testBuffer(buffer: Buffer): boolean {
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
  fs: GuardedFileSystem;
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
  await using fileHandle = await ctx.fs.open(validPath, 'r');
  const stats = await fileHandle.stat();
  if (stats.size > maxFileSize) {
    throw new FsError(
      Problem.tooLarge(
        `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
      ),
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
  const header = PathFormatter.relative(summary.root, params.filePath);
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

  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

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
    onError?: (entryPath: string, err: unknown) => void;
    runEntry: (entryPath: string) => Promise<void>;
  },
): Promise<{ stoppedByLimit: boolean; stoppedByMatchCap: boolean }> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, maxEntries, shouldStop, onEntry, onError, runEntry } = options;
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
    // Check the match cap before waiting for a slot so an in-flight task that
    // already crossed the cap stops dispatch without an extra wait...
    if (shouldStop?.()) {
      stoppedByMatchCap = true;
      break;
    }
    await waitForSlot();
    // ...and again after the slot frees, since tasks settle concurrently. The
    // cap can still be exceeded by at most `concurrency - 1` already-dispatched
    // tasks that are mid-flight; that overrun is inherent to concurrent dispatch.
    if (shouldStop?.()) {
      stoppedByMatchCap = true;
      break;
    }
    onEntry();
    dispatched++;

    // Track a non-rejecting wrapper so a rejected task can never propagate out of
    // Promise.race(pending) in waitForSlot() and abort the loop before the final
    // drain below (which would silently abandon other in-flight tasks).
    // processEntry catches all expected errors internally; if it unexpectedly
    // throws, record it as a failure rather than silently dropping it.
    const tracked = runEntry(entry.path).catch((err: unknown) => {
      onError?.(entry.path, err);
    });
    pending.add(tracked);
    void tracked.finally(() => {
      pending.delete(tracked);
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
    return {
      root: PathFormatter.dirname(resolvedPath),
      filePattern: globEscape(PathFormatter.basename(resolvedPath)),
    };
  }
  return { root: resolvedPath, filePattern: undefined };
}

function buildSearchPattern(args: SearchAndReplaceArgs): string {
  if (args.isRegex) {
    return args.wholeWord ? `\\b(?:${args.searchPattern})\\b` : args.searchPattern;
  }
  const escaped = escapeRegexLiteral(args.searchPattern);
  return args.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
}

function createReplacementMatcher(args: SearchAndReplaceArgs): ReplacementMatcher {
  // Use regex when isRegex, wholeWord, or case-insensitive (all require RE2)
  if (args.isRegex || args.wholeWord || !args.caseSensitive) {
    const pattern = buildSearchPattern(args);
    const regex = createRegexMatcher(pattern, args.caseSensitive);
    return createRegexReplacementMatcher(regex);
  }
  return createCaseSensitiveLiteralMatcher(args.searchPattern);
}

async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  fsOps: GuardedFileSystem,
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
    fs: fsOps,
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
    onError: (entryPath, err) => {
      summary.failedFiles++;
      recordFailure(summary.failures, {
        path: entryPath,
        error: Problem.fromUnknown(err, ErrorCode.UNKNOWN, entryPath),
      });
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
    const fullPath = PathFormatter.join(summary.root, primaryFilePath);

    try {
      const content = await (async (): Promise<string> => {
        const fd = await fsOps.open(fullPath, 'r');
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
        name: PathFormatter.basename(fullPath),
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
      if (isAbortError(error)) throw error;
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
    'Bulk search-and-replace across files matching a glob pattern. ' +
    'Replaces ALL occurrences per file (unlike edit, which replaces only the first match). ' +
    'Set returnDiff=true to preview changes as a unified diff before or after writing. ' +
    'Literal matching by default; set isRegex=true to enable RE2 regex with capture groups ($1, $2).',
  input: SearchAndReplaceInputSchema,
  output: SearchAndReplaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  execution: { taskSupport: 'forbidden' },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  gotchas: [
    'isRegex=true uses RE2 syntax: lookahead, lookbehind, and backreferences are not supported.',
    'Replaces ALL occurrences per file; use edit if you need to replace only the first occurrence.',
    'File patterns without a slash (e.g. *.ts) match by basename anywhere in the tree. Add a path prefix (e.g. src/*.ts) to restrict to a subtree.',
    'Passing a file path as the path argument auto-scopes the search to that single file. To scope to a directory with a glob filter, set path to the directory and use the pattern field.',
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
      ctx.fs,
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
      `replace_text: '${truncatedPattern}'${dryLabel}` +
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
