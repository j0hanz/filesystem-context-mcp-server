import type { SearchContentResult } from '../../../config/types.js';
import { normalizePath } from '../../path-utils.js';
import {
  isPathWithinDirectories,
  toAccessDeniedWithHint,
  validateExistingPathDetailed,
} from '../../path-validation.js';
import { globEntries } from '../glob-engine.js';
import type { ResolvedOptions } from './options.js';

export interface ResolvedFile {
  resolvedPath: string;
  requestedPath: string;
}

export interface ScanSummary {
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

function createScanSummary(): ScanSummary {
  return {
    filesScanned: 0,
    filesMatched: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedInaccessible: 0,
    truncated: false,
    stoppedReason: undefined,
  };
}

function shouldStopCollecting(
  summary: ScanSummary,
  maxFilesScanned: number,
  signal: AbortSignal
): boolean {
  if (signal.aborted) {
    summary.truncated = true;
    summary.stoppedReason = 'timeout';
    return true;
  }
  if (summary.filesScanned >= maxFilesScanned) {
    summary.truncated = true;
    summary.stoppedReason = 'maxFiles';
    return true;
  }
  return false;
}

async function resolveEntryPath(
  entry: { path: string; dirent: { isSymbolicLink(): boolean } },
  allowedDirs: readonly string[],
  signal: AbortSignal
): Promise<ResolvedFile | null> {
  try {
    return entry.dirent.isSymbolicLink()
      ? await validateExistingPathDetailed(entry.path, signal)
      : resolveNonSymlinkPath(entry.path, allowedDirs);
  } catch {
    return null;
  }
}

async function collectFromStream(
  stream: AsyncIterable<{
    path: string;
    dirent: { isFile(): boolean; isSymbolicLink(): boolean };
  }>,
  opts: ResolvedOptions,
  allowedDirs: readonly string[],
  signal: AbortSignal,
  summary: ScanSummary
): Promise<ResolvedFile[]> {
  const files: ResolvedFile[] = [];

  for await (const entry of stream) {
    if (!entry.dirent.isFile()) continue;
    if (shouldStopCollecting(summary, opts.maxFilesScanned, signal)) {
      break;
    }

    const resolved = await resolveEntryPath(entry, allowedDirs, signal);
    if (!resolved) {
      summary.skippedInaccessible++;
      continue;
    }

    files.push(resolved);
    summary.filesScanned++;
  }

  return files;
}

/**
 * Collect file entries for scanning, up to the configured limits.
 */
export async function collectFiles(
  root: string,
  opts: ResolvedOptions,
  allowedDirs: readonly string[],
  signal: AbortSignal
): Promise<{ files: ResolvedFile[]; summary: ScanSummary }> {
  const summary = createScanSummary();

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

  const files = await collectFromStream(
    stream,
    opts,
    allowedDirs,
    signal,
    summary
  );
  return { files, summary };
}
