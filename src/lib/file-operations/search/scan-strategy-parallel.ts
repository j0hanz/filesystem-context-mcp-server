import type { ContentMatch } from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import type { ResolvedFile, ScanSummary } from './scan-collector.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import {
  applyScanResult,
  shouldStopOnSignalOrLimit,
} from './scan-strategy-shared.js';
import { getSearchWorkerPool } from './worker-pool-manager.js';
import type { ScanTask, WorkerScanResult } from './worker-pool.js';

interface WorkerOutcome {
  task: ScanTask;
  result?: WorkerScanResult;
  error?: Error;
}

interface ParallelScanState {
  matches: ContentMatch[];
  summary: ScanSummary;
  inFlight: Set<ScanTask>;
  iterator: AsyncIterator<ResolvedFile>;
  done: boolean;
  stoppedEarly: boolean;
}

interface ParallelScanConfig {
  pool: ReturnType<typeof getSearchWorkerPool>;
  pattern: string;
  matcherOptions: MatcherOptions;
  scanOptions: ScanFileOptions;
  maxResults: number;
  maxInFlight: number;
  signal: AbortSignal;
}

function createParallelScanConfig(
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal
): ParallelScanConfig {
  return {
    pool: getSearchWorkerPool(SEARCH_WORKERS),
    pattern,
    matcherOptions,
    scanOptions,
    maxResults,
    maxInFlight: Math.min(SEARCH_WORKERS, Math.max(1, maxResults)),
    signal,
  };
}

function createParallelScanState(
  files: AsyncIterable<ResolvedFile>,
  summary: ScanSummary
): ParallelScanState {
  return {
    matches: [],
    summary,
    inFlight: new Set<ScanTask>(),
    iterator: files[Symbol.asyncIterator](),
    done: false,
    stoppedEarly: false,
  };
}

function markTruncated(
  summary: ScanSummary,
  reason: ScanSummary['stoppedReason']
): void {
  summary.truncated = true;
  summary.stoppedReason = reason;
}

function cancelInFlight(inFlight: Set<ScanTask>): void {
  for (const task of inFlight) {
    task.cancel();
    void task.promise.catch(() => {});
  }
  inFlight.clear();
}

function stopIfSignaledOrLimited(
  config: ParallelScanConfig,
  state: ParallelScanState
): boolean {
  if (
    !shouldStopOnSignalOrLimit(
      config.signal,
      state.matches.length,
      config.maxResults,
      state.summary
    )
  ) {
    return false;
  }
  state.stoppedEarly = true;
  state.done = true;
  cancelInFlight(state.inFlight);
  return true;
}

async function awaitNextOutcome(
  inFlight: Set<ScanTask>
): Promise<WorkerOutcome> {
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
}

function handleWorkerOutcome(
  outcome: WorkerOutcome,
  config: ParallelScanConfig,
  state: ParallelScanState
): void {
  state.inFlight.delete(outcome.task);
  if (outcome.error) {
    if (outcome.error.message !== 'Scan cancelled') {
      state.summary.skippedInaccessible++;
    }
    return;
  }
  const { result } = outcome;
  if (!result) return;
  const remaining = config.maxResults - state.matches.length;
  if (remaining <= 0) {
    markTruncated(state.summary, 'maxResults');
    return;
  }
  applyScanResult(result, state.matches, state.summary, remaining);
  if (state.matches.length >= config.maxResults) {
    markTruncated(state.summary, 'maxResults');
  }
}

async function enqueueNextTask(
  config: ParallelScanConfig,
  state: ParallelScanState
): Promise<void> {
  if (stopIfSignaledOrLimited(config, state)) return;
  const next = await state.iterator.next();
  if (next.done) {
    state.done = true;
    return;
  }
  const remaining = Math.max(1, config.maxResults - state.matches.length);
  const task = config.pool.scan({
    resolvedPath: next.value.resolvedPath,
    requestedPath: next.value.requestedPath,
    pattern: config.pattern,
    matcherOptions: config.matcherOptions,
    scanOptions: config.scanOptions,
    maxMatches: remaining,
  });
  state.inFlight.add(task);
}

async function fillInFlight(
  config: ParallelScanConfig,
  state: ParallelScanState
): Promise<void> {
  while (!state.done && state.inFlight.size < config.maxInFlight) {
    await enqueueNextTask(config, state);
  }
}

async function drainInFlight(
  config: ParallelScanConfig,
  state: ParallelScanState
): Promise<void> {
  await fillInFlight(config, state);
  while (state.inFlight.size > 0) {
    if (stopIfSignaledOrLimited(config, state)) break;
    handleWorkerOutcome(await awaitNextOutcome(state.inFlight), config, state);
    if (stopIfSignaledOrLimited(config, state)) break;
    await fillInFlight(config, state);
  }
}

async function finalizeParallelScan(state: ParallelScanState): Promise<void> {
  if (!state.stoppedEarly) return;
  cancelInFlight(state.inFlight);
  await state.iterator.return?.();
}

function attachAbortHandler(
  config: ParallelScanConfig,
  state: ParallelScanState
): () => void {
  const onAbort = (): void => {
    state.stoppedEarly = true;
    markTruncated(state.summary, 'timeout');
    cancelInFlight(state.inFlight);
  };
  config.signal.addEventListener('abort', onAbort, { once: true });
  return onAbort;
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
  const config = createParallelScanConfig(
    pattern,
    matcherOptions,
    scanOptions,
    maxResults,
    signal
  );
  const state = createParallelScanState(files, summary);
  const onAbort = attachAbortHandler(config, state);
  try {
    await drainInFlight(config, state);
    await finalizeParallelScan(state);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return state.matches;
}
