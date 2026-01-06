import type { SearchContentResult } from '../../../config/types.js';
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
import {
  buildWorkerOptions,
  mergeOptions,
  type SearchContentOptions,
} from './options.js';
import { buildMatcher, scanFileResolved } from './scan-file.js';
import { createSearchWorker } from './worker-client.js';

function resolveNonSymlinkPath(
  entryPath: string,
  allowedDirs: readonly string[]
): { resolvedPath: string; requestedPath: string } {
  const normalized = normalizePath(entryPath);
  if (!isPathWithinDirectories(normalized, allowedDirs)) {
    throw toAccessDeniedWithHint(entryPath, normalized, normalized);
  }
  return { resolvedPath: normalized, requestedPath: normalized };
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
  const matcher = buildMatcher(pattern, opts);
  const useWorkers = SEARCH_WORKERS > 0;
  const worker = useWorkers ? createSearchWorker() : undefined;
  const workerOptions = useWorkers ? buildWorkerOptions(opts) : undefined;
  const allowedDirs = getAllowedDirectories();

  let filesScanned = 0;
  let filesMatched = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  let skippedInaccessible = 0;
  const linesSkippedDueToRegexTimeout = 0;
  let truncated = false;
  let stoppedReason: SearchContentResult['summary']['stoppedReason'];

  const matches: SearchContentResult['matches'][number][] = [];

  try {
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
        truncated = true;
        stoppedReason = 'timeout';
        break;
      }
      if (filesScanned >= opts.maxFilesScanned) {
        truncated = true;
        stoppedReason = 'maxFiles';
        break;
      }
      filesScanned++;
      const remaining = opts.maxResults - matches.length;
      if (remaining <= 0) {
        truncated = true;
        stoppedReason = 'maxResults';
        break;
      }

      try {
        const { resolvedPath, requestedPath } = entry.dirent.isSymbolicLink()
          ? await validateExistingPathDetailed(entry.path, signal)
          : resolveNonSymlinkPath(entry.path, allowedDirs);
        const scanResult = worker
          ? await worker.scan(
              {
                resolvedPath,
                requestedPath,
                pattern,
                options: workerOptions ?? buildWorkerOptions(opts),
                maxMatches: remaining,
              },
              signal
            )
          : await scanFileResolved(
              resolvedPath,
              requestedPath,
              matcher,
              opts,
              signal,
              remaining
            );

        if (scanResult.skippedTooLarge) {
          skippedTooLarge++;
        }
        if (scanResult.skippedBinary) {
          skippedBinary++;
        }
        if (scanResult.matched) {
          filesMatched++;
        }
        if (scanResult.matches.length > 0) {
          matches.push(...scanResult.matches);
        }
      } catch {
        skippedInaccessible++;
      }

      if (matches.length >= opts.maxResults) {
        truncated = true;
        stoppedReason = 'maxResults';
        break;
      }
    }

    return {
      basePath: root,
      pattern,
      filePattern: opts.filePattern,
      matches,
      summary: {
        filesScanned,
        filesMatched,
        matches: matches.length,
        truncated,
        skippedTooLarge,
        skippedBinary,
        skippedInaccessible,
        linesSkippedDueToRegexTimeout,
        stoppedReason,
      },
    };
  } finally {
    if (worker) {
      await worker.close().catch(() => undefined);
    }
    cleanup();
  }
}
