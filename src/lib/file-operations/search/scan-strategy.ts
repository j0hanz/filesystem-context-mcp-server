import type { ContentMatch } from '../../../config/types.js';
import type { ResolvedFile, ScanSummary } from './scan-collector.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import { buildMatcher, scanFileResolved } from './scan-file.js';
import {
  applyScanResult,
  shouldStopOnSignalOrLimit,
} from './scan-strategy-shared.js';

async function scanSequentialFile(
  file: ResolvedFile,
  matcher: ReturnType<typeof buildMatcher>,
  scanOptions: ScanFileOptions,
  signal: AbortSignal,
  maxResults: number,
  matches: ContentMatch[],
  summary: ScanSummary
): Promise<void> {
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
    applyScanResult(result, matches, summary, remaining);
  } catch {
    summary.skippedInaccessible++;
  }
}

async function collectSequentialMatches(
  files: AsyncIterable<ResolvedFile>,
  matcher: ReturnType<typeof buildMatcher>,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const matches: ContentMatch[] = [];
  for await (const file of files) {
    if (
      shouldStopOnSignalOrLimit(signal, matches.length, maxResults, summary)
    ) {
      break;
    }
    await scanSequentialFile(
      file,
      matcher,
      scanOptions,
      signal,
      maxResults,
      matches,
      summary
    );
  }
  return matches;
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
  return await collectSequentialMatches(
    files,
    matcher,
    scanOptions,
    maxResults,
    signal,
    summary
  );
}
