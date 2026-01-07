import type { SearchContentResult } from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import { createTimedAbortSignal } from '../../fs-helpers/abort.js';
import {
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
import { scanFilesParallel, scanFilesSequential } from './scan-strategy.js';
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
  return {
    filesScanned: summary.filesScanned,
    filesMatched: summary.filesMatched,
    matches: matches.length,
    truncated: summary.truncated,
    skippedTooLarge: summary.skippedTooLarge,
    skippedBinary: summary.skippedBinary,
    skippedInaccessible: summary.skippedInaccessible,
    linesSkippedDueToRegexTimeout: 0,
    stoppedReason: summary.stoppedReason,
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
  const traceContext = shouldPublishOpsTrace()
    ? {
        op: 'searchContent',
        engine: shouldUseWorkers() ? 'workers' : 'sequential',
        maxResults: opts.maxResults,
      }
    : undefined;
  if (traceContext) publishOpsTraceStart(traceContext);

  const matcherOptions = buildMatcherOptions(opts);
  const scanOptions = buildScanOptions(opts);

  try {
    // Validate pattern early before spawning workers
    validatePattern(pattern, matcherOptions);

    // Collect files as a stream for scanning
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
  } catch (error: unknown) {
    if (traceContext) publishOpsTraceError(traceContext, error);
    throw error;
  } finally {
    if (traceContext) publishOpsTraceEnd(traceContext);
  }
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
