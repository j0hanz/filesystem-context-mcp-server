import type { ContentMatch } from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import type { ResolvedFile, ScanSummary } from './scan-collector.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import { buildMatcher, scanFileResolved } from './scan-file.js';
import { getSearchWorkerPool } from './worker-pool-manager.js';
import type { WorkerScanResult } from './worker-pool.js';

type PendingScan = Promise<WorkerScanResult | null>;

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

function applyOutcome(
  result: Pick<
    WorkerScanResult,
    'matched' | 'skippedTooLarge' | 'skippedBinary'
  >,
  summary: ScanSummary
): void {
  if (result.skippedTooLarge) summary.skippedTooLarge++;
  if (result.skippedBinary) summary.skippedBinary++;
  if (result.matched) summary.filesMatched++;
}

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

    try {
      const remaining = maxResults - matches.length;
      const result = await scanFileResolved(
        file.resolvedPath,
        file.requestedPath,
        matcher,
        scanOptions,
        signal,
        remaining
      );
      applyOutcome(result, summary);
      if (result.matches.length > 0 && remaining > 0) {
        matches.push(...result.matches.slice(0, remaining));
      }
    } catch {
      summary.skippedInaccessible++;
    }
  }

  return matches;
}

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
  const pendingScans: PendingScan[] = [];

  for (const file of files) {
    if (shouldStopOnSignalOrLimit(signal, 0, maxResults, summary)) {
      break;
    }
    pendingScans.push(
      pool
        .scan({
          resolvedPath: file.resolvedPath,
          requestedPath: file.requestedPath,
          pattern,
          matcherOptions,
          scanOptions,
          maxMatches: maxResults,
        })
        .catch(() => null)
    );
  }

  const matches: ContentMatch[] = [];
  const results = await Promise.all(pendingScans);

  for (const result of results) {
    if (!result) {
      summary.skippedInaccessible++;
      continue;
    }

    applyOutcome(result, summary);
    if (result.matches.length > 0) {
      const remaining = maxResults - matches.length;
      if (remaining <= 0) {
        summary.truncated = true;
        summary.stoppedReason = 'maxResults';
        break;
      }
      matches.push(...result.matches.slice(0, remaining));
      if (matches.length >= maxResults) {
        summary.truncated = true;
        summary.stoppedReason = 'maxResults';
        break;
      }
    }
  }

  return matches;
}
