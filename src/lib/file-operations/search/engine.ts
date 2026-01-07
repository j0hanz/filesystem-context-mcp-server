import type {
  ContentMatch,
  SearchContentResult,
} from '../../../config/types.js';
import { SEARCH_WORKERS } from '../../constants.js';
import { createTimedAbortSignal } from '../../fs-helpers.js';
import { normalizePath } from '../../path-utils.js';
import {
  getAllowedDirectories,
  isPathWithinDirectories,
  toAccessDeniedWithHint,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../../path-validation.js';
import { globEntries } from '../glob-engine.js';
import type { ResolvedOptions } from './options.js';
import { mergeOptions, type SearchContentOptions } from './options.js';
import type { MatcherOptions, ScanFileOptions } from './scan-file.js';
import {
  buildMatcher,
  scanFileResolved,
  validatePattern,
} from './scan-file.js';
import type { WorkerScanResult } from './worker-pool.js';
import { getSearchWorkerPool, isWorkerPoolAvailable } from './worker-pool.js';

interface ResolvedFile {
  resolvedPath: string;
  requestedPath: string;
}

interface ScanSummary {
  filesScanned: number;
  filesMatched: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedInaccessible: number;
  truncated: boolean;
  stoppedReason: SearchContentResult['summary']['stoppedReason'];
}

function resolveNonSymlinkPath(
  entryPath: string,
  allowedDirs: readonly string[]
): ResolvedFile {
  const normalized = normalizePath(entryPath);
  if (!isPathWithinDirectories(normalized, allowedDirs)) {
    throw toAccessDeniedWithHint(entryPath, normalized, normalized);
  }
  return { resolvedPath: normalized, requestedPath: normalized };
}

/**
 * Collect file entries for scanning, up to the configured limits.
 */
async function collectFiles(
  root: string,
  opts: ResolvedOptions,
  allowedDirs: readonly string[],
  signal: AbortSignal
): Promise<{ files: ResolvedFile[]; summary: ScanSummary }> {
  const files: ResolvedFile[] = [];
  const summary: ScanSummary = {
    filesScanned: 0,
    filesMatched: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedInaccessible: 0,
    truncated: false,
    stoppedReason: undefined,
  };

  const stream = globEntries({
    cwd: root,
    pattern: opts.filePattern,
    excludePatterns: opts.excludePatterns,
    includeHidden: opts.includeHidden,
    baseNameMatch: opts.baseNameMatch,
    caseSensitiveMatch: opts.caseSensitiveFileMatch,
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: false,
    suppressErrors: true,
  });

  for await (const entry of stream) {
    if (!entry.dirent.isFile()) continue;
    if (signal.aborted) {
      summary.truncated = true;
      summary.stoppedReason = 'timeout';
      break;
    }
    if (summary.filesScanned >= opts.maxFilesScanned) {
      summary.truncated = true;
      summary.stoppedReason = 'maxFiles';
      break;
    }

    try {
      const resolved = entry.dirent.isSymbolicLink()
        ? await validateExistingPathDetailed(entry.path, signal)
        : resolveNonSymlinkPath(entry.path, allowedDirs);

      files.push(resolved);
      summary.filesScanned++;
    } catch {
      summary.skippedInaccessible++;
    }
  }

  return { files, summary };
}

/**
 * Scan files sequentially in the main thread.
 * Used as fallback when worker pool is not available (e.g., TypeScript source context).
 */
async function scanFilesSequential(
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
    if (signal.aborted) {
      summary.truncated = true;
      summary.stoppedReason = 'timeout';
      break;
    }

    if (matches.length >= maxResults) {
      summary.truncated = true;
      summary.stoppedReason = 'maxResults';
      break;
    }

    try {
      const result = await scanFileResolved(
        file.resolvedPath,
        file.requestedPath,
        matcher,
        scanOptions,
        signal,
        maxResults - matches.length
      );

      if (result.skippedTooLarge) summary.skippedTooLarge++;
      if (result.skippedBinary) summary.skippedBinary++;
      if (result.matched) summary.filesMatched++;
      if (result.matches.length > 0) {
        matches.push(...result.matches);
      }
    } catch {
      summary.skippedInaccessible++;
    }
  }

  return matches;
}

/**
 * Scan files in parallel using worker threads.
 * Only used when worker pool is available (compiled context).
 */
async function scanFilesParallel(
  files: readonly ResolvedFile[],
  pattern: string,
  matcherOptions: MatcherOptions,
  scanOptions: ScanFileOptions,
  maxResults: number,
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ContentMatch[]> {
  const pool = getSearchWorkerPool(SEARCH_WORKERS);
  const matches: ContentMatch[] = [];

  // Create scan promises for all files
  const pendingScans: Promise<{
    file: ResolvedFile;
    result: WorkerScanResult | null;
  }>[] = [];

  for (const file of files) {
    if (signal.aborted) {
      summary.truncated = true;
      summary.stoppedReason = 'timeout';
      break;
    }

    if (matches.length >= maxResults) {
      summary.truncated = true;
      summary.stoppedReason = 'maxResults';
      break;
    }

    const scanPromise = pool
      .scan({
        resolvedPath: file.resolvedPath,
        requestedPath: file.requestedPath,
        pattern,
        matcherOptions,
        scanOptions,
        maxMatches: maxResults - matches.length,
      })
      .then((result) => ({ file, result }))
      .catch(() => ({ file, result: null }));

    pendingScans.push(scanPromise);
  }

  // Wait for all scans to complete
  const results = await Promise.all(pendingScans);

  // Process results
  for (const { result } of results) {
    if (!result) {
      summary.skippedInaccessible++;
      continue;
    }

    if (result.skippedTooLarge) summary.skippedTooLarge++;
    if (result.skippedBinary) summary.skippedBinary++;
    if (result.matched) summary.filesMatched++;
    if (result.matches.length > 0) {
      // Respect maxResults limit
      const remaining = maxResults - matches.length;
      if (remaining > 0) {
        const toAdd = result.matches.slice(0, remaining);
        matches.push(...toAdd);
        if (matches.length >= maxResults) {
          summary.truncated = true;
          summary.stoppedReason = 'maxResults';
        }
      }
    }
  }

  return matches;
}

export async function searchContent(
  basePath: string,
  pattern: string,
  options: SearchContentOptions = {}
): Promise<SearchContentResult> {
  const opts = mergeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    opts.timeoutMs
  );
  const root = await validateExistingDirectory(basePath, signal);
  const allowedDirs = getAllowedDirectories();

  const matcherOptions: MatcherOptions = {
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    isLiteral: opts.isLiteral,
  };
  const scanOptions: ScanFileOptions = {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
  };

  // Validate pattern early before spawning workers
  validatePattern(pattern, matcherOptions);

  try {
    // Collect files first
    const { files, summary } = await collectFiles(
      root,
      opts,
      allowedDirs,
      signal
    );

    // Choose scanning strategy based on worker pool availability
    const useWorkers = isWorkerPoolAvailable() && SEARCH_WORKERS > 0;
    const matches = useWorkers
      ? await scanFilesParallel(
          files,
          pattern,
          matcherOptions,
          scanOptions,
          opts.maxResults,
          signal,
          summary
        )
      : await scanFilesSequential(
          files,
          pattern,
          matcherOptions,
          scanOptions,
          opts.maxResults,
          signal,
          summary
        );

    return {
      basePath: root,
      pattern,
      filePattern: opts.filePattern,
      matches,
      summary: {
        filesScanned: summary.filesScanned,
        filesMatched: summary.filesMatched,
        matches: matches.length,
        truncated: summary.truncated,
        skippedTooLarge: summary.skippedTooLarge,
        skippedBinary: summary.skippedBinary,
        skippedInaccessible: summary.skippedInaccessible,
        linesSkippedDueToRegexTimeout: 0,
        stoppedReason: summary.stoppedReason,
      },
    };
  } finally {
    cleanup();
  }
}
