import type { ContentMatch } from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import type { ResolvedFile, ScanSummary } from './scan-collector.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import { buildMatcher, scanFileResolved } from './scan-file.js';
import { getSearchWorkerPool } from './worker-pool-manager.js';
import type { ScanTask, WorkerScanResult } from './worker-pool.js';

type PendingScan = ScanTask;

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
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const matcher = buildMatcher(pattern, matcherOptions);
  const matches: ContentMatch[] = [];

  for await (const file of files) {
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
  files: AsyncIterable<ResolvedFile>,
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const pool = getSearchWorkerPool(SEARCH_WORKERS);
  const matches: ContentMatch[] = [];
  const inFlight = new Set<PendingScan>();
  const iterator = files[Symbol.asyncIterator]();
  let done = false;
  let stoppedEarly = false;
  const maxInFlight = Math.min(SEARCH_WORKERS, Math.max(1, maxResults));

  const cancelInFlight = (): void => {
    for (const task of inFlight) {
      task.cancel();
      void task.promise.catch(() => {});
    }
    inFlight.clear();
  };

  const handleOutcome = (outcome: {
    task: PendingScan;
    result?: WorkerScanResult;
    error?: Error;
  }): void => {
    inFlight.delete(outcome.task);
    if (outcome.error) {
      if (outcome.error.message === 'Scan cancelled') {
        return;
      }
      summary.skippedInaccessible++;
      return;
    }
    const { result } = outcome;
    if (!result) return;

    applyOutcome(result, summary);
    if (result.matches.length > 0) {
      const remaining = maxResults - matches.length;
      if (remaining <= 0) {
        summary.truncated = true;
        summary.stoppedReason = 'maxResults';
        return;
      }
      matches.push(...result.matches.slice(0, remaining));
      if (matches.length >= maxResults) {
        summary.truncated = true;
        summary.stoppedReason = 'maxResults';
      }
    }
  };

  const awaitNext = async (): Promise<{
    task: PendingScan;
    result?: WorkerScanResult;
    error?: Error;
  }> => {
    const races = [...inFlight].map((task) =>
      task.promise.then(
        (result) => ({ task, result }),
        (error: unknown) => ({
          task,
          error: error instanceof Error ? error : new Error(String(error)),
        })
      )
    );
    return await Promise.race(races);
  };

  const enqueue = async (): Promise<void> => {
    while (!done && inFlight.size < maxInFlight) {
      if (
        shouldStopOnSignalOrLimit(signal, matches.length, maxResults, summary)
      ) {
        stoppedEarly = true;
        done = true;
        cancelInFlight();
        return;
      }

      const next = await iterator.next();
      if (next.done) {
        done = true;
        break;
      }

      const remaining = Math.max(1, maxResults - matches.length);
      const task = pool.scan({
        resolvedPath: next.value.resolvedPath,
        requestedPath: next.value.requestedPath,
        pattern,
        matcherOptions,
        scanOptions,
        maxMatches: remaining,
      });
      inFlight.add(task);
    }
  };

  const onAbort = (): void => {
    stoppedEarly = true;
    summary.truncated = true;
    summary.stoppedReason = 'timeout';
    cancelInFlight();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    await enqueue();

    while (inFlight.size > 0) {
      if (
        shouldStopOnSignalOrLimit(signal, matches.length, maxResults, summary)
      ) {
        stoppedEarly = true;
        cancelInFlight();
        break;
      }

      handleOutcome(await awaitNext());
      if (
        shouldStopOnSignalOrLimit(signal, matches.length, maxResults, summary)
      ) {
        stoppedEarly = true;
        cancelInFlight();
        break;
      }

      await enqueue();
    }

    if (stoppedEarly) {
      cancelInFlight();
      await iterator.return?.();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  return matches;
}
