/**
 * Worker thread script for parallel file content searching.
 *
 * This script runs in a worker thread and handles file scanning requests.
 * It receives scan requests via parentPort and returns results.
 *
 * Protocol:
 * - Receive: { type: 'scan', id, resolvedPath, requestedPath, pattern, matcherOptions, scanOptions }
 * - Send: { type: 'result', id, result } | { type: 'error', id, error }
 * - Receive: { type: 'cancel', id } - Cancel a pending scan
 * - Receive: { type: 'shutdown' } - Graceful shutdown
 */
import { parentPort, workerData } from 'node:worker_threads';

import type { ContentMatch } from '../../../config/types.js';
import { isProbablyBinary } from '../../fs-helpers/binary-detect.js';
import type { Matcher, MatcherOptions, ScanFileOptions } from './scan-file.js';
import { buildMatcher } from './scan-file.js';
import { scanFileInWorker } from './worker-scan.js';

interface ScanRequest {
  type: 'scan';
  id: number;
  resolvedPath: string;
  requestedPath: string;
  pattern: string;
  matcherOptions: MatcherOptions;
  scanOptions: ScanFileOptions;
  maxMatches: number;
}

interface CancelRequest {
  type: 'cancel';
  id: number;
}

interface ShutdownRequest {
  type: 'shutdown';
}

type WorkerRequest = ScanRequest | CancelRequest | ShutdownRequest;

interface ScanResult {
  type: 'result';
  id: number;
  result: {
    matches: readonly ContentMatch[];
    matched: boolean;
    skippedTooLarge: boolean;
    skippedBinary: boolean;
  };
}

interface ScanError {
  type: 'error';
  id: number;
  error: string;
}

type WorkerResponse = ScanResult | ScanError;

// Cache matchers by pattern+options to avoid rebuilding
const matcherCache = new Map<string, Matcher>();

function getMatcherCacheKey(pattern: string, options: MatcherOptions): string {
  const cs = options.caseSensitive ? '1' : '0';
  const ww = options.wholeWord ? '1' : '0';
  const lit = options.isLiteral ? '1' : '0';
  return `${pattern}|${cs}|${ww}|${lit}`;
}

function getCachedMatcher(pattern: string, options: MatcherOptions): Matcher {
  const key = getMatcherCacheKey(pattern, options);
  let matcher = matcherCache.get(key);
  if (!matcher) {
    matcher = buildMatcher(pattern, options);
    matcherCache.set(key, matcher);
    // Limit cache size to prevent memory leaks
    if (matcherCache.size > 100) {
      const firstKey = matcherCache.keys().next().value;
      if (firstKey !== undefined) {
        matcherCache.delete(firstKey);
      }
    }
  }
  return matcher;
}

// Track cancelled requests
const cancelledRequests = new Set<number>();

function consumeCancelled(id: number): boolean {
  if (!cancelledRequests.has(id)) {
    return false;
  }
  cancelledRequests.delete(id);
  return true;
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
    error: error instanceof Error ? error.message : String(error),
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

  // Check if already cancelled before starting
  if (consumeCancelled(id)) return;

  try {
    const matcher = getCachedMatcher(pattern, matcherOptions);

    // Check cancellation periodically during scan
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

    // Don't send result if cancelled
    if (consumeCancelled(id)) return;
    parentPort?.postMessage(buildScanResponse(id, result));
  } catch (err) {
    // Don't send error if cancelled
    if (consumeCancelled(id)) return;
    parentPort?.postMessage(buildErrorResponse(id, err));
  }
}

function handleMessage(message: WorkerRequest): void {
  switch (message.type) {
    case 'scan':
      void handleScanRequest(message);
      break;
    case 'cancel':
      cancelledRequests.add(message.id);
      break;
    case 'shutdown':
      process.exit(0);
      break;
  }
}

// Initialize worker
if (parentPort) {
  parentPort.on('message', handleMessage);

  // Log worker startup in debug mode
  const data = workerData as { debug?: boolean; threadId?: number } | null;
  if (data?.debug) {
    console.error(
      `[SearchWorker] Started with threadId=${String(data.threadId)}`
    );
  }
}

export type { WorkerResponse, ScanRequest, ScanResult };
