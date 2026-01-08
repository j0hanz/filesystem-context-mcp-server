import type { ContentMatch } from '../../../config/types.js';
import type { ScanSummary } from './scan-collector.js';

interface ScanResultLike {
  matches: readonly ContentMatch[];
  matched: boolean;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
}

export function shouldStopOnSignalOrLimit(
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

export function applyScanResult(
  result: ScanResultLike,
  matches: ContentMatch[],
  summary: ScanSummary,
  remaining: number
): void {
  if (result.skippedTooLarge) summary.skippedTooLarge++;
  if (result.skippedBinary) summary.skippedBinary++;
  if (result.matched) summary.filesMatched++;
  if (result.matches.length > 0 && remaining > 0) {
    matches.push(...result.matches.slice(0, remaining));
  }
}
