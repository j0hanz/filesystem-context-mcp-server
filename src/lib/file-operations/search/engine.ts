import type { SearchContentResult } from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import { createTimedAbortSignal } from '../../fs-helpers/abort.js';
import {
  type OpsTraceContext,
  publishOpsTraceEnd,
  publishOpsTraceError,
  publishOpsTraceStart,
  shouldPublishOpsTrace,
} from '../../observability/diagnostics.js';
import { getAllowedDirectories } from '../../path-validation/allowed-directories.js';
import { validateExistingDirectory } from '../../path-validation/validate-existing.js';
import type { ResolvedOptions, SearchContentOptions } from './options.js';
import { mergeOptions } from './options.js';
import type { ResolvedFile, ScanSummary } from './scan-collector.js';
import { collectFilesStream } from './scan-collector.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import { validatePattern } from './scan-file.js';
import { scanFilesSequential } from './scan-strategy.js';
import { isWorkerPoolAvailable } from './worker-pool.js';

function buildMatcherOptions(opts: ResolvedOptions): MatcherOptions {
  return {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
  };
}

function buildScanOptions(opts: ResolvedOptions): ScanFileOptions {
  return {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
  };
}

function shouldUseWorkers(): boolean {
  return isWorkerPoolAvailable() && SEARCH_WORKERS > 0;
}

function buildTraceContext(opts: ResolvedOptions): OpsTraceContext | undefined {
  if (!shouldPublishOpsTrace()) return undefined;
  return {
    op: 'searchContent',
    engine: shouldUseWorkers() ? 'workers' : 'sequential',
    maxResults: opts.maxResults,
  };
}

async function withOpsTrace<T>(
  context: OpsTraceContext | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!context) {
    return await run();
  }
  publishOpsTraceStart(context);
  try {
    return await run();
  } catch (error: unknown) {
    publishOpsTraceError(context, error);
    throw error;
  } finally {
    publishOpsTraceEnd(context);
  }
}

async function scanMatches(
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<SearchContentResult['matches']> {
  if (shouldUseWorkers()) {
    return await scanMatchesParallel(
      files,
      pattern,
      matcherOptions,
      scanOptions,
      maxResults,
      signal,
      summary
    );
  }
  return await scanMatchesSequential(
    files,
    pattern,
    matcherOptions,
    scanOptions,
    maxResults,
    signal,
    summary
  );
}

async function scanMatchesParallel(
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<SearchContentResult['matches']> {
  const { scanFilesParallel } = await import('./scan-strategy-parallel.js');
  return await scanFilesParallel(
    files,
    pattern,
    matcherOptions,
    scanOptions,
    maxResults,
    signal,
    summary
  );
}

async function scanMatchesSequential(
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<SearchContentResult['matches']> {
  return await scanFilesSequential(
    files,
    pattern,
    matcherOptions,
    scanOptions,
    maxResults,
    signal,
    summary
  );
}

function buildSummary(
  summary: ScanSummary,
  matches: SearchContentResult['matches']
): SearchContentResult['summary'] {
  const baseSummary: SearchContentResult['summary'] = {
    filesScanned: summary.filesScanned,
    filesMatched: summary.filesMatched,
    matches: matches.length,
    truncated: summary.truncated,
    skippedTooLarge: summary.skippedTooLarge,
    skippedBinary: summary.skippedBinary,
    skippedInaccessible: summary.skippedInaccessible,
    linesSkippedDueToRegexTimeout: 0,
  };
  return {
    ...baseSummary,
    ...(summary.stoppedReason !== undefined
      ? { stoppedReason: summary.stoppedReason }
      : {}),
  };
}

function buildSearchResult(
  root: string,
  pattern: string,
  filePattern: string,
  matches: SearchContentResult['matches'],
  summary: ScanSummary
): SearchContentResult {
  return {
    basePath: root,
    pattern,
    filePattern,
    matches,
    summary: buildSummary(summary, matches),
  };
}

async function executeSearch(
  root: string,
  pattern: string,
  opts: ResolvedOptions,
  allowedDirs: readonly string[],
  signal: AbortSignal
): Promise<SearchContentResult> {
  const matcherOptions = buildMatcherOptions(opts);
  const scanOptions = buildScanOptions(opts);
  const traceContext = buildTraceContext(opts);

  return await withOpsTrace(traceContext, async () => {
    validatePattern(pattern, matcherOptions);
    const { stream, summary } = collectFilesStream(
      root,
      opts,
      allowedDirs,
      signal
    );
    const matches = await scanMatches(
      stream,
      pattern,
      matcherOptions,
      scanOptions,
      opts.maxResults,
      signal,
      summary
    );
    return buildSearchResult(root, pattern, opts.filePattern, matches, summary);
  });
}

export async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {}
): Promise<SearchContentResult> {
  const opts = mergeOptions(options);
  const root = await validateExistingDirectory(basePath, options.signal);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    opts.timeoutMs
  );
  const allowedDirs = getAllowedDirectories();

  try {
    return await executeSearch(root, pattern, opts, allowedDirs, signal);
  } finally {
    cleanup();
  }
}
