import fg from 'fast-glob';

import { PARALLEL_CONCURRENCY } from '../../constants.js';
import { safeDestroy } from '../../fs-helpers.js';
import {
  type BaseFileOptions,
  buildBaseOptions,
  buildSearchLimits,
  finalizeTimeoutState,
  markMaxFiles,
  markMaxResults,
  type SearchLimits,
  shouldAbortOrStop,
  throwIfAborted,
  updateState,
} from './engine-stream-state.js';
import type { SearchOptions as EngineSearchOptions } from './engine.js';
import { processFile } from './file-processor.js';
import type { Matcher } from './match-strategy.js';
import type { SearchState } from './types.js';

export function createStream(
  basePath: string,
  options: EngineSearchOptions
): AsyncIterable<string | Buffer> {
  return fg.stream(options.filePattern, {
    cwd: basePath,
    absolute: true,
    onlyFiles: true,
    dot: options.includeHidden,
    ignore: options.excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
    baseNameMatch: options.baseNameMatch,
    caseSensitiveMatch: options.caseSensitiveFileMatch,
  });
}

interface MatchBudget {
  hasRemaining: () => boolean;
  reserve: () => boolean;
}

function createMatchBudget(maxResults: number): MatchBudget {
  const budget = { remaining: maxResults };
  return {
    hasRemaining: () => budget.remaining > 0,
    reserve: () => {
      if (budget.remaining <= 0) return false;
      budget.remaining -= 1;
      return true;
    },
  };
}

async function runFileTask(
  rawPath: string,
  matcher: Matcher,
  baseOptions: BaseFileOptions,
  state: SearchState,
  limits: SearchLimits,
  deadlineMs: number | undefined,
  matchBudget: MatchBudget,
  signal?: AbortSignal
): Promise<void> {
  try {
    if (shouldAbortOrStop(signal, state, limits, deadlineMs)) return;
    if (!matchBudget.hasRemaining()) {
      markMaxResults(state);
      return;
    }
    const result = await processFile(rawPath, matcher, {
      ...baseOptions,
      currentMatchCount: state.matches.length,
      getCurrentMatchCount: () => state.matches.length,
      hasRemainingMatchBudget: matchBudget.hasRemaining,
      reserveMatchSlot: matchBudget.reserve,
      signal,
    });
    updateState(state, result, limits.maxResults);
  } catch {
    state.skippedInaccessible++;
  }
}

function scheduleTask(active: Set<Promise<void>>, task: Promise<void>): void {
  active.add(task);
  void task.finally(() => {
    active.delete(task);
  });
}

async function enforceFileBudget(
  active: Set<Promise<void>>,
  state: SearchState,
  limits: SearchLimits
): Promise<'process' | 'skip' | 'stop'> {
  if (state.filesScanned + active.size < limits.maxFilesScanned) {
    return 'process';
  }
  if (active.size === 0) {
    markMaxFiles(state);
    return 'stop';
  }
  await Promise.race(active);
  return 'skip';
}

async function waitForConcurrencySlot(
  active: Set<Promise<void>>,
  signal: AbortSignal | undefined,
  state: SearchState,
  limits: SearchLimits,
  deadlineMs?: number
): Promise<boolean> {
  while (active.size >= PARALLEL_CONCURRENCY) {
    await Promise.race(active);
    if (shouldAbortOrStop(signal, state, limits, deadlineMs)) return false;
  }
  return true;
}

async function handleStreamEntry(
  entry: string | Buffer,
  active: Set<Promise<void>>,
  state: SearchState,
  matcher: Matcher,
  baseOptions: BaseFileOptions,
  limits: SearchLimits,
  matchBudget: MatchBudget,
  deadlineMs: number | undefined,
  signal?: AbortSignal
): Promise<boolean> {
  if (shouldAbortOrStop(signal, state, limits, deadlineMs)) return false;
  if (!matchBudget.hasRemaining()) {
    markMaxResults(state);
    return false;
  }

  const budgetDecision = await enforceFileBudget(active, state, limits);
  if (budgetDecision !== 'process') {
    return budgetDecision === 'skip';
  }

  const hasSlot = await waitForConcurrencySlot(
    active,
    signal,
    state,
    limits,
    deadlineMs
  );
  if (!hasSlot) return false;
  if (shouldAbortOrStop(signal, state, limits, deadlineMs)) return false;

  scheduleTask(
    active,
    runFileTask(
      String(entry),
      matcher,
      baseOptions,
      state,
      limits,
      deadlineMs,
      matchBudget,
      signal
    )
  );

  return true;
}

async function drainStreamEntries(
  stream: AsyncIterable<string | Buffer>,
  active: Set<Promise<void>>,
  state: SearchState,
  matcher: Matcher,
  baseOptions: BaseFileOptions,
  limits: SearchLimits,
  matchBudget: MatchBudget,
  deadlineMs: number | undefined,
  signal?: AbortSignal
): Promise<void> {
  for await (const entry of stream) {
    const shouldContinue = await handleStreamEntry(
      entry,
      active,
      state,
      matcher,
      baseOptions,
      limits,
      matchBudget,
      deadlineMs,
      signal
    );
    if (!shouldContinue) break;
  }
}

function handleStreamError(
  error: unknown,
  deadlineMs: number | undefined,
  signal?: AbortSignal
): void {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) {
    return;
  }
  if (signal?.aborted) {
    const abortError = new Error('Search aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
  throw error;
}

async function runWithAbortController(
  stream: AsyncIterable<string | Buffer>,
  searchState: SearchState,
  deadlineMs: number | undefined,
  active: Set<Promise<void>>,
  signal: AbortSignal | undefined,
  run: () => Promise<void>
): Promise<void> {
  const destroyStream = (): void => {
    safeDestroy(stream as unknown);
  };

  let stopReason: 'timeout' | 'abort' | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (!timeoutId) return;
    clearTimeout(timeoutId);
    timeoutId = undefined;
  };

  const stop = (reason: 'timeout' | 'abort'): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    if (reason === 'timeout') {
      searchState.truncated = true;
      searchState.stoppedReason = 'timeout';
    }
    destroyStream();
  };

  const onAbortSignal = (): void => {
    const reason =
      deadlineMs !== undefined && Date.now() >= deadlineMs
        ? 'timeout'
        : 'abort';
    stop(reason);
    clearTimer();
  };

  const onTimeoutSignal = (): void => {
    if (stopReason === 'abort') return;
    stop('timeout');
  };

  if (signal?.aborted) {
    onAbortSignal();
  } else if (signal) {
    signal.addEventListener('abort', onAbortSignal, { once: true });
  }

  if (deadlineMs !== undefined) {
    const delay = Math.max(0, deadlineMs - Date.now());
    timeoutId = setTimeout(onTimeoutSignal, delay);
  }

  try {
    await run();
  } catch (error) {
    handleStreamError(error, deadlineMs, signal);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbortSignal);
    clearTimer();
    const shouldWaitForActive =
      !signal?.aborted &&
      !(deadlineMs !== undefined && Date.now() >= deadlineMs);
    if (shouldWaitForActive) {
      await Promise.all(active);
    }
  }
}

export async function processStream(
  stream: AsyncIterable<string | Buffer>,
  searchState: SearchState,
  matcher: Matcher,
  options: EngineSearchOptions,
  deadlineMs: number | undefined,
  searchPattern: string,
  signal?: AbortSignal
): Promise<void> {
  const active = new Set<Promise<void>>();
  const limits = buildSearchLimits(options);
  const baseOptions = buildBaseOptions(options, deadlineMs, searchPattern);
  const matchBudget = createMatchBudget(limits.maxResults);

  await runWithAbortController(
    stream,
    searchState,
    deadlineMs,
    active,
    signal,
    async () => {
      await drainStreamEntries(
        stream,
        active,
        searchState,
        matcher,
        baseOptions,
        limits,
        matchBudget,
        deadlineMs,
        signal
      );
    }
  );

  finalizeTimeoutState(searchState, deadlineMs);
  throwIfAborted(signal, deadlineMs);
}
