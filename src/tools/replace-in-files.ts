import { Buffer } from 'node:buffer';
import { type FileHandle, open } from 'node:fs/promises';
import { basename, relative } from 'node:path';

import { createTwoFilesPatch } from 'diff';
import RE2 from 're2';
import type { z } from 'zod/v4';

import { atomicWriteFile } from '../lib/atomic-write.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../lib/constants.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  McpError,
} from '../lib/errors.js';
import { globEntries } from '../lib/fs-walk.js';
import { Logger } from '../lib/logger.js';
import { validateExistingPath, validatePathForWrite } from '../lib/paths.js';
import { runInWorker, shouldOffload } from '../lib/worker-pool.js';
import {
  safeGlobConstraint,
  toToolJsonSchema,
} from '../schemas/json-schema.js';

import {
  SearchAndReplaceInputSchema,
  SearchAndReplaceOutputSchema,
} from '../schemas.js';
import { defineTool } from './define-tool.js';
import { FILE_EDIT_ICONS } from './icons.js';
import {
  buildStructuredError,
  buildToolResponse,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  resolvePathOrRoot,
  runWithProgressSession,
  type ToolContract,
  type ToolResponse,
  truncateProgressPattern,
} from './shared.js';

const SEARCH_AND_REPLACE_TOOL: ToolContract = {
  name: 'search_and_replace',
  title: 'Search and Replace',
  description:
    'Bulk search-and-replace across files matching a glob. ' +
    'Replaces ALL occurrences per file (unlike `edit`: first only). ' +
    'Always `dryRun:true` first \u2014 returns a unified diff. ' +
    'Literal matching by default; `isRegex:true` enables RE2 with capture groups ($1, $2).',
  inputSchema: SearchAndReplaceInputSchema,
  inputSchemaJson: toToolJsonSchema(SearchAndReplaceInputSchema, (s) => ({
    ...s,
    allOf: [
      ...(Array.isArray(s.allOf) ? (s.allOf as unknown[]) : []),
      safeGlobConstraint('pattern'),
    ],
  })),
  outputSchema: SearchAndReplaceOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  icons: FILE_EDIT_ICONS,
  gotchas: [
    'RE2 dialect: no lookahead, lookbehind, or backreferences.',
    'Replaces ALL occurrences per file; use `edit` for first-only replacement.',
  ],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

const MAX_FAILURES = 20;
const REPLACE_CONCURRENCY = Math.min(PARALLEL_CONCURRENCY, 8);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output
const DIFF_APPEND_BUFFER = 1024;

interface Failure {
  path: string;
  error: NonNullable<
    z.infer<typeof SearchAndReplaceOutputSchema>['failures']
  >[number]['error'];
}

function recordFailure(failures: Failure[], failure: Failure): void {
  if (failures.length >= MAX_FAILURES) return;
  failures.push(failure);
}

function recordChangedFile(
  summary: ReplaceSummary,
  filePath: string,
  matchCount: number
): void {
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
    throw new McpError(
      ErrorCode.INVALID_PATTERN,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`
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
  caseSensitive: boolean
): ReplacementMatcher {
  const patternLength = searchPattern.length;
  const searchBuffer = caseSensitive
    ? Buffer.from(searchPattern, 'utf8')
    : null;

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
}

interface ReplacementPlan {
  matchCount: number;
  originalContent: string;
  updatedContent: string;
}

function buildReplacementPlan(
  content: string,
  replacement: string,
  matcher: ReplacementMatcher
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

function formatFileTooLargeError(
  filePath: string,
  size: number,
  maxFileSize: number
): string {
  return `File too large: ${filePath} (${size} bytes > ${maxFileSize} bytes)`;
}

async function processEntry(
  entryPath: string,
  ctx: ReplaceContext
): Promise<void> {
  const { options, signal, summary } = ctx;

  let validPath: string;
  try {
    validPath = await validatePathForWrite(entryPath, signal);
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: entryPath,
      error: buildStructuredError(error, ErrorCode.UNKNOWN, entryPath),
    });
    return;
  }

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
    });

    if (!options.dryRun) {
      await atomicWriteFile(validPath, plan.updatedContent, {
        encoding: 'utf-8',
        signal,
      });
    }
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: validPath,
      error: buildStructuredError(error, ErrorCode.UNKNOWN, validPath),
    });
  }
}

async function readReplacementPlan(
  validPath: string,
  ctx: ReplaceContext
): Promise<ReplacementPlan | undefined> {
  const { matcher, replacement, maxFileSize, signal } = ctx;
  let fileHandle: FileHandle | undefined;
  try {
    const fd = await open(validPath, 'r');
    fileHandle = fd;
    const stats = await fileHandle.stat();
    if (stats.size > maxFileSize) {
      throw new Error(
        formatFileTooLargeError(validPath, stats.size, maxFileSize)
      );
    }

    let content: string;
    if (matcher.testBuffer) {
      const buffer = await fileHandle.readFile({ signal });
      if (!matcher.testBuffer(buffer)) {
        return undefined;
      }
      content = buffer.toString('utf-8');
    } else {
      content = await fileHandle.readFile({
        encoding: 'utf-8',
        signal,
      });
    }

    return buildReplacementPlan(content, replacement, matcher);
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

async function maybeAppendPatchDiff(
  summary: ReplaceSummary,
  params: {
    filePath: string;
    originalContent: string;
    updatedContent: string;
    includeDiff: boolean;
  }
): Promise<void> {
  if (!params.includeDiff) return;
  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

  const patch = await (async (): Promise<string> => {
    const totalBytes =
      Buffer.byteLength(params.originalContent) +
      Buffer.byteLength(params.updatedContent);
    if (shouldOffload(totalBytes)) {
      const result = await runInWorker('diffLines', {
        oldStr: params.originalContent,
        newStr: params.updatedContent,
        oldHeader: basename(params.filePath),
        newHeader: basename(params.filePath),
      });
      return result.unifiedDiff;
    }
    return new Promise<string>((resolve) => {
      // Defer to event loop to avoid blocking on large diffs
      setImmediate(() => {
        createTwoFilesPatch(
          basename(params.filePath),
          basename(params.filePath),
          params.originalContent,
          params.updatedContent,
          'Original',
          'Modified',
          {
            callback: (res: string | undefined) => {
              resolve(res ?? '');
            },
          }
        );
      });
    });
  })();

  if (
    summary.diff.length + patch.length <=
    MAX_DIFF_SIZE + DIFF_APPEND_BUFFER
  ) {
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
  }
): Promise<{ stoppedByLimit: boolean; stoppedByMatchCap: boolean }> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, maxEntries, shouldStop, onEntry, runEntry } =
    options;
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
  signal?: AbortSignal
): Promise<string> {
  return pathValue
    ? validateExistingPath(pathValue, signal)
    : resolvePathOrRoot(pathValue);
}

function buildSearchPattern(args: SearchAndReplaceArgs): string {
  if (args.isRegex) {
    return args.wholeWord
      ? `\\b(?:${args.searchPattern})\\b`
      : args.searchPattern;
  }
  const escaped = args.searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return args.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
}

function createReplacementMatcher(
  args: SearchAndReplaceArgs
): ReplacementMatcher {
  // Use regex when isRegex, wholeWord, or case-insensitive (all require RE2)
  if (args.isRegex || args.wholeWord || !args.caseSensitive) {
    const pattern = buildSearchPattern(args);
    const regex = createRegexMatcher(pattern, args.caseSensitive);
    return createRegexReplacementMatcher(regex);
  }
  return createLiteralReplacementMatcher(
    args.searchPattern,
    args.caseSensitive
  );
}

async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  signal?: AbortSignal,
  onProgress: (progress: { total?: number; current: number }) => void = () =>
    undefined
): Promise<ToolResponse<SearchAndReplaceOutput>> {
  const maxFileSize = MAX_TEXT_FILE_SIZE;
  const root = await resolveSearchRoot(args.path, signal);
  const matcher = createReplacementMatcher(args);

  const entries = globEntries({
    cwd: root,
    pattern: args.pattern ?? '**/*',
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    includeHidden: args.includeHidden,
    baseNameMatch: false,
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
  };

  const { stoppedByLimit, stoppedByMatchCap } =
    await processEntriesConcurrently(entries, {
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
      `search_and_replace: ${summary.filesChanged} file(s), ${summary.totalMatches} match(es)`
    );
  }

  return buildToolResponse(
    buildSearchAndReplaceText(summary, args.dryRun),
    buildSearchAndReplaceStructuredResult(summary, args)
  );
}

export const SEARCH_AND_REPLACE = defineTool<
  SearchAndReplaceArgs,
  SearchAndReplaceOutput
>({
  contract: SEARCH_AND_REPLACE_TOOL,
  defaultErrorCode: ErrorCode.UNKNOWN,
  diagnosticsContext: (args) => (args.path ? { path: args.path } : {}),
  run: async (args, ctx) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    const truncatedPattern = truncateProgressPattern(args.searchPattern);
    const context = `"${truncatedPattern}" in ${args.pattern ?? '**/*'}${dryLabel}`;
    const label = `${SEARCH_AND_REPLACE_TOOL.title}: ${context}`;

    return runWithProgressSession(ctx, label, async (progress) => {
      const progressWithMessage = ({
        current,
        total,
      }: {
        total?: number;
        current: number;
      }): void => {
        progress.update({
          current,
          ...(total !== undefined ? { total } : {}),
          message: `${SEARCH_AND_REPLACE_TOOL.title}: ${truncatedPattern} [${current} files]`,
        });
      };

      const result = await handleSearchAndReplace(
        args,
        ctx.signal,
        progressWithMessage
      );
      const sc = result.structuredContent;
      const finalCurrent = resolveFinalProgressCurrent(
        progress,
        sc.processedFiles + 1
      );
      const matchWord = sc.matches === 1 ? 'match' : 'matches';
      const fileWord = sc.filesChanged === 1 ? 'file' : 'files';
      let suffix = `${sc.matches} ${matchWord} in ${sc.filesChanged} ${fileWord}`;
      if (sc.failedFiles) suffix += `, ${sc.failedFiles} failed`;
      if (!args.dryRun) {
        void ctx.log?.(
          'info',
          `search_and_replace: ${String(sc.matches)} matches in ${String(sc.filesChanged)} files`,
          'search_and_replace'
        );
      }
      return { value: result, suffix, finalCurrent };
    });
  },
});

function buildSearchAndReplaceText(
  summary: ReplaceSummary,
  dryRun: boolean
): string {
  const failureSuffix =
    summary.failedFiles > 0 ? ` (${summary.failedFiles} failed)` : '';
  const dryRunSuffix = dryRun ? ' (Dry run)' : '';
  const timing = summary.perfTimeMs
    ? ` [\u23F1\uFE0F ${summary.perfTimeMs.toFixed(0)}ms]`
    : '';
  return `Found ${summary.totalMatches} matches in ${summary.filesChanged} files${failureSuffix}.${dryRunSuffix}${timing}`;
}

function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  args: SearchAndReplaceArgs
): SearchAndReplaceOutput {
  return {
    ok: true,
    matches: summary.totalMatches,
    filesChanged: summary.filesChanged,
    processedFiles: summary.processedFiles,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    ...(summary.failures.length > 0 ? { failures: summary.failures } : {}),
    ...(summary.changedFiles.length > 0
      ? { changedFiles: summary.changedFiles }
      : {}),
    ...(summary.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
    ...((args.dryRun || args.returnDiff) && summary.diff
      ? { diff: summary.diff }
      : {}),
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
  };
}
