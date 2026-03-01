import { parentPort, threadId, workerData } from 'node:worker_threads';

import { formatUnknownErrorMessage } from '../errors.js';
import { isProbablyBinary } from '../fs-helpers.js';
import { startPerfMeasure } from '../observability.js';
import { scanFileInWorker } from './search-content.js';
import type {
  ScanError,
  ScanRequest,
  ScanResult,
  WorkerResponse,
} from './search-content.js';
import { buildMatcher } from './search-matcher.js';
import { type Matcher, type MatcherOptions } from './search-matcher.js';

interface CancelRequest {
  type: 'cancel';
  id: number;
}

interface ShutdownRequest {
  type: 'shutdown';
}

type WorkerRequest = ScanRequest | CancelRequest | ShutdownRequest;

const matcherCache = new Map<string, Matcher>();
const MAX_MATCHER_CACHE_SIZE = 100;

function getMatcherCacheKey(pattern: string, options: MatcherOptions): string {
  const cs = options.caseSensitive ? '1' : '0';
  const ww = options.wholeWord ? '1' : '0';
  const lit = options.isLiteral ? '1' : '0';
  return `${pattern}|${cs}|${ww}|${lit}`;
}

function getCachedMatcher(pattern: string, options: MatcherOptions): Matcher {
  const key = getMatcherCacheKey(pattern, options);
  const cached = matcherCache.get(key);

  if (cached) {
    refreshMatcherCacheEntry(key, cached);
    return cached;
  }

  const matcher = buildMatcher(pattern, options);
  refreshMatcherCacheEntry(key, matcher);
  evictOldestMatcherIfNeeded();

  return matcher;
}

function refreshMatcherCacheEntry(key: string, matcher: Matcher): void {
  matcherCache.delete(key);
  matcherCache.set(key, matcher);
}

function evictOldestMatcherIfNeeded(): void {
  if (matcherCache.size <= MAX_MATCHER_CACHE_SIZE) return;
  const firstKey = matcherCache.keys().next().value;
  if (firstKey !== undefined) {
    matcherCache.delete(firstKey);
  }
}

const cancelledRequests = new Set<number>();
const activeRequests = new Set<number>();
let shuttingDown = false;

function maybeFinishShutdown(): void {
  if (!shuttingDown) return;
  if (activeRequests.size > 0) return;
  parentPort?.close();
}

function consumeCancelled(id: number): boolean {
  if (!cancelledRequests.has(id)) {
    return false;
  }
  cancelledRequests.delete(id);
  return true;
}

function markCancelledIfActive(id: number): void {
  if (activeRequests.has(id)) {
    cancelledRequests.add(id);
  }
}

function buildScanResponse(
  id: number,
  result: ScanResult['result']
): ScanResult {
  return {
    type: 'result',
    id,
    result,
  };
}

function buildErrorResponse(id: number, error: unknown): ScanError {
  return {
    type: 'error',
    id,
    error: formatUnknownErrorMessage(error),
  };
}

async function handleScanRequest(request: ScanRequest): Promise<void> {
  const {
    id,
    resolvedPath,
    requestedPath,
    pattern,
    matcherOptions,
    scanOptions,
    maxMatches,
  } = request;

  if (consumeCancelled(id)) return;
  activeRequests.add(id);

  const endMeasure = startPerfMeasure('searchWorker.scan', {
    maxMatches,
  });
  let ok = false;

  try {
    const matcher = getCachedMatcher(pattern, matcherOptions);

    const isCancelled = (): boolean => cancelledRequests.has(id);

    const result = await scanFileInWorker(
      resolvedPath,
      requestedPath,
      matcher,
      scanOptions,
      maxMatches,
      isCancelled,
      isProbablyBinary
    );

    if (consumeCancelled(id)) return;
    parentPort?.postMessage(buildScanResponse(id, result));
    ok = true;
  } catch (err) {
    if (consumeCancelled(id)) return;
    parentPort?.postMessage(buildErrorResponse(id, err));
  } finally {
    activeRequests.delete(id);
    cancelledRequests.delete(id);
    endMeasure?.(ok);
    maybeFinishShutdown();
  }
}

function handleMessage(message: WorkerRequest): void {
  switch (message.type) {
    case 'scan':
      if (shuttingDown) return;
      void handleScanRequest(message);
      break;
    case 'cancel':
      markCancelledIfActive(message.id);
      break;
    case 'shutdown':
      shuttingDown = true;
      for (const id of activeRequests) {
        markCancelledIfActive(id);
      }
      maybeFinishShutdown();
      break;
  }
}

if (parentPort) {
  parentPort.on('message', handleMessage);

  const data = workerData as { debug?: boolean } | null;
  if (data?.debug) {
    console.error(`[SearchWorker] Started with threadId=${String(threadId)}`);
  }
}

export type { WorkerResponse, ScanRequest, ScanResult };
