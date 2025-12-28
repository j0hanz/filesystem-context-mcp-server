import fg from 'fast-glob';

import { PARALLEL_CONCURRENCY } from '../../constants.js';
import { safeDestroy } from '../../fs-helpers.js';
import type { SearchOptions } from './engine-options.js';
import { processFile } from './file-processor.js';
import type { Matcher } from './match-strategy.js';
import type { ScanResult, SearchState } from './types.js';

type StreamStopReason = 'timeout' | 'abort' | null;

export function createStream(
  basePath: string,
  options: SearchOptions
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

function shouldStop(
  state: SearchState,
  options: SearchOptions,
  deadlineMs?: number
): boolean {
  if (deadlineMs && Date.now() > deadlineMs) {
    state.truncated = true;
    state.stoppedReason = 'timeout';
    return true;
  }
  if (state.filesScanned >= options.maxFilesScanned) {
    state.truncated = true;
    state.stoppedReason = 'maxFiles';
    return true;
  }
  if (state.matches.length >= options.maxResults) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
    return true;
  }
  return false;
}

function updateState(
  state: SearchState,
  result: ScanResult,
  options: SearchOptions
): void {
  state.filesScanned++;
  if (!result.scanned) {
    state.skippedInaccessible++;
    return;
  }

  if (result.skippedTooLarge) state.skippedTooLarge++;
  if (result.skippedBinary) state.skippedBinary++;

  if (result.matches.length > 0) {
    state.filesMatched++;
    const remaining = options.maxResults - state.matches.length;
    if (remaining > 0) {
      if (result.matches.length > remaining) {
        state.matches.push(...result.matches.slice(0, remaining));
        state.truncated = true;
        state.stoppedReason = 'maxResults';
      } else {
        state.matches.push(...result.matches);
      }
    } else if (!state.truncated) {
      state.truncated = true;
      state.stoppedReason = 'maxResults';
    }
  }
  state.linesSkippedDueToRegexTimeout += result.linesSkippedDueToRegexTimeout;
  if (result.hitMaxResults && !state.truncated) {
    state.truncated = true;
    state.stoppedReason = 'maxResults';
  }
}

export async function processStream(
  stream: AsyncIterable<string | Buffer>,
  searchState: SearchState,
  matcher: Matcher,
  options: SearchOptions,
  deadlineMs: number | undefined,
  searchPattern: string,
  signal?: AbortSignal
): Promise<void> {
  const active = new Set<Promise<void>>();
  let inFlight = 0;
  let stopReason: StreamStopReason = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const destroyStream = (): void => {
    safeDestroy(stream as unknown);
  };

  const onAbort = (): void => {
    if (stopReason === null) {
      const isTimeout = deadlineMs !== undefined && Date.now() >= deadlineMs;
      if (isTimeout) {
        stopReason = 'timeout';
        searchState.truncated = true;
        searchState.stoppedReason = 'timeout';
      } else {
        stopReason = 'abort';
      }
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    destroyStream();
  };

  if (signal?.aborted) {
    onAbort();
  } else if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  if (deadlineMs !== undefined) {
    const delay = Math.max(0, deadlineMs - Date.now());
    timeoutId = setTimeout(() => {
      if (stopReason === 'abort') return;
      stopReason = 'timeout';
      searchState.truncated = true;
      searchState.stoppedReason = 'timeout';
      destroyStream();
    }, delay);
  }

  const baseOptions = {
    maxResults: options.maxResults,
    contextLines: options.contextLines,
    deadlineMs,
    isLiteral: options.isLiteral,
    wholeWord: options.wholeWord,
    caseSensitive: options.caseSensitive,
    maxFileSize: options.maxFileSize,
    skipBinary: options.skipBinary,
    searchPattern,
  };

  try {
    for await (const entry of stream) {
      if (signal?.aborted) break;
      if (shouldStop(searchState, options, deadlineMs)) break;

      if (searchState.filesScanned + inFlight >= options.maxFilesScanned) {
        if (active.size === 0) {
          searchState.truncated = true;
          searchState.stoppedReason = 'maxFiles';
          break;
        }
        await Promise.race(active);
        continue;
      }

      while (active.size >= PARALLEL_CONCURRENCY) {
        await Promise.race(active);
        if (signal?.aborted) break;
        if (shouldStop(searchState, options, deadlineMs)) break;
      }

      if (signal?.aborted) break;
      if (shouldStop(searchState, options, deadlineMs)) break;

      const rawPath = String(entry);
      const task = (async (): Promise<void> => {
        try {
          if (signal?.aborted) return;
          if (shouldStop(searchState, options, deadlineMs)) return;
          const result = await processFile(rawPath, matcher, {
            ...baseOptions,
            currentMatchCount: searchState.matches.length,
            getCurrentMatchCount: () => searchState.matches.length,
            signal,
          });
          updateState(searchState, result, options);
        } catch {
          searchState.skippedInaccessible++;
        }
      })();
      inFlight += 1;
      active.add(task);
      void task.finally(() => {
        active.delete(task);
        inFlight -= 1;
      });
    }
  } catch (error) {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      // fall through to finalize below
    } else if (signal?.aborted) {
      const abortError = new Error('Search aborted');
      abortError.name = 'AbortError';
      throw abortError;
    } else {
      throw error;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (timeoutId) clearTimeout(timeoutId);
    await Promise.all(active);
  }
  if (deadlineMs && Date.now() > deadlineMs && !searchState.truncated) {
    searchState.truncated = true;
    searchState.stoppedReason = 'timeout';
  }
  if (signal?.aborted) {
    if (deadlineMs && Date.now() >= deadlineMs) return;
    throw new Error('Search aborted');
  }
}
