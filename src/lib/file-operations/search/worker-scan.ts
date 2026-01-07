/**
 * Worker-safe file scanning function.
 *
 * This module provides a file scanning function that can be used within
 * worker threads. It doesn't rely on any shared state from the main thread.
 */
import type { FileHandle } from 'node:fs/promises';

import type { ContentMatch } from '../../../config/types.js';
import { scanFileWithMatcher } from './scan-runner.js';
import type { Matcher, ScanFileOptions } from './scan-types.js';

type BinaryDetector = (
  path: string,
  handle: FileHandle,
  signal?: AbortSignal
) => Promise<boolean>;

export interface WorkerScanResult {
  readonly matches: readonly ContentMatch[];
  readonly matched: boolean;
  readonly skippedTooLarge: boolean;
  readonly skippedBinary: boolean;
}

/**
 * Scans a file for content matches within a worker thread.
 *
 * This function is similar to scanFileResolved but designed for worker threads:
 * - Takes a cancellation check function instead of AbortSignal
 * - Takes binary detector as a parameter to avoid module-level state
 */
export async function scanFileInWorker(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean,
  isProbablyBinary: BinaryDetector
): Promise<WorkerScanResult> {
  const result = await scanFileWithMatcher(resolvedPath, requestedPath, {
    matcher,
    options,
    maxMatches,
    isCancelled,
    isProbablyBinary,
  });
  return {
    matches: result.matches,
    matched: result.matched,
    skippedTooLarge: result.skippedTooLarge,
    skippedBinary: result.skippedBinary,
  };
}
