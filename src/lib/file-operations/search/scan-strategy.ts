import type { ContentMatch } from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import type { ResolvedFile, ScanSummary } from './scan-collector.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import { buildMatcher, scanFileResolved } from './scan-file.js';
import { getSearchWorkerPool } from './worker-pool-manager.js';
import type { WorkerScanResult } from './worker-pool.js';

interface ScanOutcome {
  matches: readonly ContentMatch[];
  matched: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
}

type PendingScan = Promise<{
  file: ResolvedFile;
  result: WorkerScanResult | null;
}>;

function shouldStopOnSignalOrLimit(
  signal: AbortSignal,
  matchesCount: number,
  maxResults: number,
  summary: ScanSummary
): boolean {
  if (signal.aborted) {
    summary.truncated = true;
    summary.stoppedReason = 'timeout';
    return true;
  }
  if (matchesCount >= maxResults) {
    summary.truncated = true;
    summary.stoppedReason = 'maxResults';
    return true;
  }
  return false;
}

function applyOutcome(outcome: ScanOutcome, summary: ScanSummary): void {
  if (outcome.skippedTooLarge) summary.skippedTooLarge++;
  if (outcome.skippedBinary) summary.skippedBinary++;
  if (outcome.matched) summary.filesMatched++;
}

function appendMatches(
  matches: ContentMatch[],
  newMatches: readonly ContentMatch[],
  maxResults: number
): number {
  if (newMatches.length === 0) return 0;
  const remaining = maxResults - matches.length;
  if (remaining <= 0) return 0;
  const toAdd = newMatches.slice(0, remaining);
  matches.push(...toAdd);
  return toAdd.length;
}

function finalizeParallelMatchLimit(
  matches: ContentMatch[],
  maxResults: number,
  summary: ScanSummary
): void {
  if (matches.length >= maxResults) {
    summary.truncated = true;
    summary.stoppedReason = 'maxResults';
  }
}

async function scanSequentialFile(
  file: ResolvedFile,
  matcher: ReturnType<typeof buildMatcher>,
  scanOptions: ScanFileOptions,
  signal: AbortSignal,
  remaining: number,
  summary: ScanSummary
): Promise<readonly ContentMatch[]> {
  try {
    const result = await scanFileResolved(
      file.resolvedPath,
      file.requestedPath,
      matcher,
      scanOptions,
      signal,
      remaining
    );
    applyOutcome(result, summary);
    return result.matches;
  } catch {
    summary.skippedInaccessible++;
    return [];
  }
}

/**
 * Scan files sequentially in the main thread.
 * Used as fallback when worker pool is not available (e.g., TypeScript source context).
 */
export async function scanFilesSequential(
  files: readonly ResolvedFile[],
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const matcher = buildMatcher(pattern, matcherOptions);
  const matches: ContentMatch[] = [];

  for (const file of files) {
    if (
      shouldStopOnSignalOrLimit(signal, matches.length, maxResults, summary)
    ) {
      break;
    }

    const newMatches = await scanSequentialFile(
      file,
      matcher,
      scanOptions,
      signal,
      maxResults - matches.length,
      summary
    );
    appendMatches(matches, newMatches, maxResults);
  }

  return matches;
}

function createScanPromise(
  pool: ReturnType<typeof getSearchWorkerPool>,
  file: ResolvedFile,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxMatches: number
): Promise<{ file: ResolvedFile; result: WorkerScanResult | null }> {
  return pool
    .scan({
      resolvedPath: file.resolvedPath,
      requestedPath: file.requestedPath,
      pattern,
      matcherOptions,
      scanOptions,
      maxMatches,
    })
    .then((result) => ({ file, result }))
    .catch(() => ({ file, result: null }));
}

function enqueueScanPromises(
  files: readonly ResolvedFile[],
  pool: ReturnType<typeof getSearchWorkerPool>,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): PendingScan[] {
  const pendingScans: PendingScan[] = [];

  for (const file of files) {
    if (shouldStopOnSignalOrLimit(signal, 0, maxResults, summary)) {
      break;
    }
    pendingScans.push(
      createScanPromise(
        pool,
        file,
        pattern,
        matcherOptions,
        scanOptions,
        maxResults
      )
    );
  }

  return pendingScans;
}

function applyWorkerResults(
  results: { result: WorkerScanResult | null }[],
  matches: ContentMatch[],
  maxResults: number,
  summary: ScanSummary
): void {
  for (const { result } of results) {
    if (!result) {
      summary.skippedInaccessible++;
      continue;
    }

    applyOutcome(result, summary);
    appendMatches(matches, result.matches, maxResults);
    finalizeParallelMatchLimit(matches, maxResults, summary);
  }
}

/**
 * Scan files in parallel using worker threads.
 * Only used when worker pool is available (compiled context).
 */
export async function scanFilesParallel(
  files: readonly ResolvedFile[],
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const pool = getSearchWorkerPool(SEARCH_WORKERS);
  const matches: ContentMatch[] = [];

  const pendingScans = enqueueScanPromises(
    files,
    pool,
    pattern,
    matcherOptions,
    scanOptions,
    maxResults,
    signal,
    summary
  );
  const results = await Promise.all(pendingScans);
  applyWorkerResults(results, matches, maxResults, summary);

  return matches;
}
