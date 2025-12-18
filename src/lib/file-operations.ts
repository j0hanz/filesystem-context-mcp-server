import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';

import fg from 'fast-glob';
import { Minimatch } from 'minimatch';
import safeRegex from 'safe-regex2';

import type {
  AnalyzeDirectoryResult,
  ContentMatch,
  DirectoryAnalysis,
  DirectoryEntry,
  DirectoryTreeResult,
  FileInfo,
  FileType,
  ListDirectoryResult,
  MediaFileResult,
  SearchContentResult,
  SearchFilesResult,
  SearchResult,
  TreeEntry,
} from '../config/types.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_RESULTS,
  DEFAULT_TOP_N,
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_MAX_FILES,
  DIR_TRAVERSAL_CONCURRENCY,
  getMimeType,
  MAX_MEDIA_FILE_SIZE,
  MAX_SEARCHABLE_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from './constants.js';
import { ErrorCode, McpError } from './errors.js';
import {
  getFileType,
  isHidden,
  isProbablyBinary,
  processInParallel,
  readFile,
  runWorkQueue,
} from './fs-helpers.js';
import { parseImageDimensions } from './image-parsing.js';
import {
  validateExistingPath,
  validateExistingPathDetailed,
} from './path-validation.js';
import {
  isSimpleSafePattern,
  prepareSearchPattern,
  scanFileForContent,
} from './search-helpers.js';

function createExcludeMatcher(
  excludePatterns: string[]
): (name: string, relativePath: string) => boolean {
  if (excludePatterns.length === 0) {
    return () => false;
  }
  const matchers = excludePatterns.map((pattern) => new Minimatch(pattern));
  return (name: string, relativePath: string): boolean =>
    matchers.some((m) => m.match(name) || m.match(relativePath));
}

function classifyAccessError(error: unknown): 'symlink' | 'inaccessible' {
  if (
    error instanceof McpError &&
    (error.code === ErrorCode.E_ACCESS_DENIED ||
      error.code === ErrorCode.E_SYMLINK_NOT_ALLOWED)
  ) {
    return 'symlink';
  }
  return 'inaccessible';
}

interface DirectoryIterationEntry {
  item: Dirent;
  name: string;
  fullPath: string;
  relativePath: string;
}

interface DirectoryIterationOptions {
  includeHidden: boolean;
  shouldExclude: (name: string, relativePath: string) => boolean;
  onInaccessible: () => void;
  shouldStop?: () => boolean;
}

async function forEachDirectoryEntry(
  currentPath: string,
  basePath: string,
  options: DirectoryIterationOptions,
  handler: (entry: DirectoryIterationEntry) => Promise<void>
): Promise<void> {
  let items: Dirent[];
  try {
    items = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    options.onInaccessible();
    return;
  }

  for (const item of items) {
    if (options.shouldStop?.()) break;
    const { name } = item;
    if (!options.includeHidden && isHidden(name)) {
      continue;
    }

    const fullPath = path.join(currentPath, name);
    const relativePath = path.relative(basePath, fullPath);
    if (options.shouldExclude(name, relativePath)) {
      continue;
    }

    await handler({ item, name, fullPath, relativePath });
  }
}

interface DirectoryItemResult {
  entry: DirectoryEntry;
  enqueueDir?: { currentPath: string; depth: number };
  skippedInaccessible?: boolean;
  symlinkNotFollowed?: boolean;
}

async function buildDirectoryItemResult(
  item: Dirent,
  currentPath: string,
  basePath: string,
  options: {
    includeSymlinkTargets: boolean;
    recursive: boolean;
    depth: number;
    maxDepth: number;
  }
): Promise<DirectoryItemResult> {
  const fullPath = path.join(currentPath, item.name);
  const relativePath = path.relative(basePath, fullPath) || item.name;

  try {
    if (item.isSymbolicLink()) {
      const stats = await fs.lstat(fullPath);

      let symlinkTarget: string | undefined;
      if (options.includeSymlinkTargets) {
        try {
          symlinkTarget = await fs.readlink(fullPath);
        } catch {
          // Symlink target unreadable
        }
      }

      const entry: DirectoryEntry = {
        name: item.name,
        path: fullPath,
        relativePath,
        type: 'symlink',
        size: stats.size,
        modified: stats.mtime,
        symlinkTarget,
      };
      return { entry, symlinkNotFollowed: true };
    }

    const stats = await fs.stat(fullPath);
    const isDir = item.isDirectory();
    let type: FileType;
    if (isDir) {
      type = 'directory';
    } else if (item.isFile()) {
      type = 'file';
    } else {
      type = getFileType(stats);
    }

    const entry: DirectoryEntry = {
      name: item.name,
      path: fullPath,
      relativePath,
      type,
      size: type === 'file' ? stats.size : undefined,
      modified: stats.mtime,
    };

    const enqueueDir =
      options.recursive && isDir && options.depth + 1 <= options.maxDepth
        ? {
            currentPath: await validateExistingPath(fullPath),
            depth: options.depth + 1,
          }
        : undefined;

    return { entry, enqueueDir };
  } catch {
    let type: FileType;
    if (item.isDirectory()) {
      type = 'directory';
    } else if (item.isFile()) {
      type = 'file';
    } else {
      type = 'other';
    }
    const entry: DirectoryEntry = {
      name: item.name,
      path: fullPath,
      relativePath,
      type,
    };
    return { entry, skippedInaccessible: true };
  }
}

function pushTopN<T>(
  arr: T[],
  item: T,
  compare: (a: T, b: T) => number,
  maxLen: number
): void {
  if (maxLen <= 0) return;
  arr.push(item);
  if (arr.length > maxLen) {
    arr.sort(compare);
    arr.length = maxLen;
  }
}

type SortField = 'name' | 'size' | 'modified' | 'type' | 'path';

interface Sortable {
  name?: string;
  size?: number;
  modified?: Date;
  type?: FileType;
  path?: string;
}

const SORT_COMPARATORS: Readonly<
  Record<SortField, (a: Sortable, b: Sortable) => number>
> = {
  size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
  modified: (a, b) =>
    (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0),
  type: (a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return (a.name ?? '').localeCompare(b.name ?? '');
  },
  path: (a, b) => (a.path ?? '').localeCompare(b.path ?? ''),
  name: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
};

function sortByField(items: Sortable[], sortBy: SortField): void {
  const comparator = SORT_COMPARATORS[sortBy];
  items.sort(comparator);
}

function sortSearchResults(
  results: Sortable[],
  sortBy: 'name' | 'size' | 'modified' | 'path'
): void {
  if (sortBy === 'name') {
    results.sort((a, b) =>
      path.basename(a.path ?? '').localeCompare(path.basename(b.path ?? ''))
    );
  } else {
    sortByField(results, sortBy);
  }
}

function shouldStopListDirectory(
  maxEntries: number | undefined,
  entries: DirectoryEntry[]
): { stop: boolean; truncated: boolean } {
  if (maxEntries !== undefined && entries.length >= maxEntries) {
    return { stop: true, truncated: true };
  }
  return { stop: false, truncated: false };
}

function buildSearchRegex(
  searchPattern: string,
  options: {
    isLiteral: boolean;
    wholeWord: boolean;
    caseSensitive: boolean;
    basePath: string;
  }
): { regex: RegExp; finalPattern: string } {
  const { isLiteral, wholeWord, caseSensitive, basePath } = options;

  const finalPattern = prepareSearchPattern(searchPattern, {
    isLiteral,
    wholeWord,
  });

  const needsReDoSCheck = !isLiteral && !isSimpleSafePattern(finalPattern);

  if (needsReDoSCheck && !safeRegex(finalPattern)) {
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Potentially unsafe regular expression (ReDoS risk): ${searchPattern}. ` +
        'Avoid patterns with nested quantifiers, overlapping alternations, or exponential backtracking.',
      basePath,
      { reason: 'ReDoS risk detected' }
    );
  }

  try {
    const regex = new RegExp(finalPattern, caseSensitive ? 'g' : 'gi');
    return { regex, finalPattern };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Invalid regular expression: ${finalPattern} (${message})`,
      basePath,
      { searchPattern: finalPattern }
    );
  }
}

async function toSearchResult(
  match: string
): Promise<SearchResult | { error: Error }> {
  try {
    const { requestedPath, resolvedPath, isSymlink } =
      await validateExistingPathDetailed(match);
    const stats = await fs.stat(resolvedPath);
    const { size, mtime: modified } = stats;
    return {
      path: requestedPath,
      type: isSymlink ? 'symlink' : getFileType(stats),
      size: stats.isFile() ? size : undefined,
      modified,
    };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function scanCandidateFile(
  openPath: string,
  displayPath: string,
  regex: RegExp,
  options: {
    maxResults: number;
    currentMatchCount: number;
    maxFileSize: number;
    skipBinary: boolean;
    isLiteral: boolean;
    searchPattern: string;
    caseSensitive: boolean;
    contextLines: number;
    wholeWord: boolean;
    deadlineMs?: number;
  }
): Promise<{
  matches: ContentMatch[];
  fileHadMatches: boolean;
  linesSkippedDueToRegexTimeout: number;
  skippedTooLarge: boolean;
  skippedBinary: boolean;
  scanned: boolean;
}> {
  const {
    maxResults,
    currentMatchCount,
    maxFileSize,
    skipBinary,
    isLiteral,
    searchPattern,
    caseSensitive,
    contextLines,
    wholeWord,
    deadlineMs,
  } = options;

  const handle = await fs.open(openPath, 'r');

  try {
    const stats = await handle.stat();
    if (stats.size > maxFileSize) {
      return {
        matches: [],
        fileHadMatches: false,
        linesSkippedDueToRegexTimeout: 0,
        skippedTooLarge: true,
        skippedBinary: false,
        scanned: true,
      };
    }

    if (skipBinary) {
      const binary = await isProbablyBinary(openPath, handle);
      if (binary) {
        return {
          matches: [],
          fileHadMatches: false,
          linesSkippedDueToRegexTimeout: 0,
          skippedTooLarge: false,
          skippedBinary: true,
          scanned: true,
        };
      }
    }

    const scanResult = await scanFileForContent(openPath, regex, {
      maxResults,
      contextLines,
      deadlineMs,
      currentMatchCount,
      isLiteral,
      searchString: isLiteral ? searchPattern : undefined,
      caseSensitive,
      wholeWord,
      fileHandle: handle,
    });

    for (const match of scanResult.matches) {
      match.file = displayPath;
    }

    return {
      matches: scanResult.matches,
      fileHadMatches: scanResult.fileHadMatches,
      linesSkippedDueToRegexTimeout: scanResult.linesSkippedDueToRegexTimeout,
      skippedTooLarge: false,
      skippedBinary: false,
      scanned: true,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function getPermissions(mode: number): string {
  const PERM_STRINGS = [
    '---',
    '--x',
    '-w-',
    '-wx',
    'r--',
    'r-x',
    'rw-',
    'rwx',
  ] as const satisfies readonly string[];

  const ownerIndex = (mode >> 6) & 0b111;
  const groupIndex = (mode >> 3) & 0b111;
  const otherIndex = mode & 0b111;
  const owner = PERM_STRINGS[ownerIndex] ?? '---';
  const group = PERM_STRINGS[groupIndex] ?? '---';
  const other = PERM_STRINGS[otherIndex] ?? '---';

  return `${owner}${group}${other}`;
}

export async function getFileInfo(filePath: string): Promise<FileInfo> {
  const { requestedPath, resolvedPath, isSymlink } =
    await validateExistingPathDetailed(filePath);

  const name = path.basename(requestedPath);
  const ext = path.extname(name).toLowerCase();
  const mimeType = ext ? getMimeType(ext) : undefined;

  let symlinkTarget: string | undefined;
  if (isSymlink) {
    try {
      symlinkTarget = await fs.readlink(requestedPath);
    } catch {
      // Symlink target unreadable
    }
  }

  const stats = await fs.stat(resolvedPath);

  return {
    name,
    path: requestedPath,
    type: isSymlink ? 'symlink' : getFileType(stats),
    size: stats.size,
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    permissions: getPermissions(stats.mode),
    isHidden: isHidden(name),
    mimeType,
    symlinkTarget,
  };
}

export async function listDirectory(
  dirPath: string,
  options: {
    recursive?: boolean;
    includeHidden?: boolean;
    maxDepth?: number;
    maxEntries?: number;
    sortBy?: 'name' | 'size' | 'modified' | 'type';
    includeSymlinkTargets?: boolean;
  } = {}
): Promise<ListDirectoryResult> {
  const {
    recursive = false,
    includeHidden = false,
    maxDepth = DEFAULT_MAX_DEPTH,
    maxEntries,
    sortBy = 'name',
    includeSymlinkTargets = false,
  } = options;
  const validPath = await validateExistingPath(dirPath);

  const entries: DirectoryEntry[] = [];
  let totalFiles = 0;
  let totalDirectories = 0;
  let maxDepthReached = 0;
  let truncated = false;
  let skippedInaccessible = 0;
  let symlinksNotFollowed = 0;

  const stopIfNeeded = (): boolean => {
    const decision = shouldStopListDirectory(maxEntries, entries);
    if (decision.truncated) truncated = true;
    return decision.stop;
  };

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: validPath, depth: 0 }],
    async ({ currentPath, depth }, enqueue) => {
      if (depth > maxDepth) return;
      if (stopIfNeeded()) return;
      maxDepthReached = Math.max(maxDepthReached, depth);

      let items;
      try {
        items = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        skippedInaccessible++;
        return;
      }

      const visibleItems = includeHidden
        ? items
        : items.filter((item) => !isHidden(item.name));

      const { results: processedEntries, errors: processingErrors } =
        await processInParallel(visibleItems, async (item) =>
          buildDirectoryItemResult(item, currentPath, validPath, {
            includeSymlinkTargets,
            recursive,
            depth,
            maxDepth,
          })
        );

      skippedInaccessible += processingErrors.length;

      for (const result of processedEntries) {
        const {
          entry,
          enqueueDir,
          skippedInaccessible: skippedInaccessibleItem,
          symlinkNotFollowed: symlinkNotFollowedItem,
        } = result;
        if (stopIfNeeded()) break;
        entries.push(entry);
        if (entry.type === 'directory') totalDirectories++;
        if (entry.type === 'file') totalFiles++;
        if (enqueueDir) enqueue(enqueueDir);
        if (skippedInaccessibleItem) {
          skippedInaccessible++;
        }
        if (symlinkNotFollowedItem) {
          symlinksNotFollowed++;
        }
      }
    },
    DIR_TRAVERSAL_CONCURRENCY
  );

  sortByField(entries, sortBy);

  return {
    path: validPath,
    entries,
    summary: {
      totalEntries: entries.length,
      totalFiles,
      totalDirectories,
      maxDepthReached,
      truncated,
      skippedInaccessible,
      symlinksNotFollowed,
    },
  };
}

export async function searchFiles(
  basePath: string,
  pattern: string,
  excludePatterns: string[] = [],
  options: {
    maxResults?: number;
    sortBy?: 'name' | 'size' | 'modified' | 'path';
    maxDepth?: number;
  } = {}
): Promise<SearchFilesResult> {
  const validPath = await validateExistingPath(basePath);

  const { maxResults, sortBy = 'path', maxDepth } = options;

  const results: SearchResult[] = [];
  let skippedInaccessible = 0;
  let truncated = false;
  let filesScanned = 0;

  const batch: string[] = [];

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const toProcess = batch.splice(0, batch.length);

    const settled = await Promise.allSettled(
      toProcess.map(async (match) => toSearchResult(match))
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if ('error' in r.value) {
          skippedInaccessible++;
          continue;
        }
        if (maxResults !== undefined && results.length >= maxResults) {
          truncated = true;
          return;
        }
        results.push(r.value);
        if (maxResults !== undefined && results.length >= maxResults) {
          truncated = true;
          return;
        }
      } else {
        skippedInaccessible++;
      }
    }
  };

  const stream = fg.stream(pattern, {
    cwd: validPath,
    absolute: true,
    onlyFiles: false,
    dot: true,
    ignore: excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
    deep: maxDepth,
  });

  for await (const entry of stream) {
    const matchPath = typeof entry === 'string' ? entry : String(entry);
    filesScanned++;

    if (maxResults !== undefined && results.length >= maxResults) {
      truncated = true;
      break;
    }

    batch.push(matchPath);
    if (batch.length >= PARALLEL_CONCURRENCY) {
      await flushBatch();
      if (maxResults !== undefined && results.length >= maxResults) {
        truncated = true;
        break;
      }
    }
  }

  if (!truncated) {
    await flushBatch();
  }

  sortSearchResults(results, sortBy);

  return {
    basePath: validPath,
    pattern,
    results,
    summary: {
      matched: results.length,
      truncated,
      skippedInaccessible,
      filesScanned,
    },
  };
}

export { readFile };

export async function readMultipleFiles(
  filePaths: string[],
  options: {
    encoding?: BufferEncoding;
    maxSize?: number;
    maxTotalSize?: number;
    head?: number;
    tail?: number;
  } = {}
): Promise<{ path: string; content?: string; error?: string }[]> {
  const {
    encoding = 'utf-8',
    maxSize = MAX_TEXT_FILE_SIZE,
    maxTotalSize = 100 * 1024 * 1024,
    head,
    tail,
  } = options;
  const isPartialRead = head !== undefined || tail !== undefined;

  if (filePaths.length === 0) return [];

  const output: { path: string; content?: string; error?: string }[] =
    filePaths.map((filePath) => ({ path: filePath }));

  let totalSize = 0;
  const fileSizes = new Map<string, number>();

  for (const filePath of filePaths) {
    try {
      const validPath = await validateExistingPath(filePath);
      const stats = await fs.stat(validPath);
      fileSizes.set(filePath, stats.size);
      if (!isPartialRead) {
        totalSize += stats.size;
      }
    } catch {
      fileSizes.set(filePath, 0);
    }
  }

  if (!isPartialRead && totalSize > maxTotalSize) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `Total size of all files (${totalSize} bytes) exceeds limit (${maxTotalSize} bytes)`,
      undefined,
      { totalSize, maxTotalSize, fileCount: filePaths.length }
    );
  }

  const { results, errors } = await processInParallel(
    filePaths.map((filePath, index) => ({ filePath, index })),
    async ({ filePath, index }) => {
      const result = await readFile(filePath, {
        encoding,
        maxSize,
        head,
        tail,
      });

      return {
        index,
        value: { path: result.path, content: result.content },
      };
    },
    PARALLEL_CONCURRENCY
  );

  for (const r of results) {
    output[r.index] = r.value;
  }
  for (const e of errors) {
    const filePath = filePaths[e.index] ?? '(unknown)';
    output[e.index] = {
      path: filePath,
      error: e.error.message,
    };
  }

  return output;
}

type SearchStopReason = SearchContentResult['summary']['stoppedReason'];

function getSearchStopReason(
  deadlineMs: number | undefined,
  maxFilesScanned: number | undefined,
  maxResults: number,
  filesScanned: number,
  matchCount: number
): SearchStopReason | undefined {
  if (deadlineMs !== undefined && Date.now() > deadlineMs) return 'timeout';
  if (maxFilesScanned !== undefined && filesScanned >= maxFilesScanned) {
    return 'maxFiles';
  }
  if (matchCount >= maxResults) return 'maxResults';
  return undefined;
}

function applySearchStop(
  reason: SearchStopReason,
  state: { truncated: boolean; stoppedReason: SearchStopReason | undefined }
): void {
  state.truncated = true;
  state.stoppedReason = reason;
}

async function resolveSearchPath(
  rawPath: string
): Promise<{ openPath: string; displayPath: string } | null> {
  try {
    const validatedPath = await validateExistingPathDetailed(rawPath);
    return {
      openPath: validatedPath.resolvedPath,
      displayPath: validatedPath.requestedPath,
    };
  } catch {
    return null;
  }
}

export async function searchContent(
  basePath: string,
  searchPattern: string,
  options: {
    filePattern?: string;
    excludePatterns?: string[];
    caseSensitive?: boolean;
    maxResults?: number;
    maxFileSize?: number;
    maxFilesScanned?: number;
    timeoutMs?: number;
    skipBinary?: boolean;
    contextLines?: number;
    wholeWord?: boolean;
    isLiteral?: boolean;
    includeHidden?: boolean;
  } = {}
): Promise<SearchContentResult> {
  const {
    filePattern = '**/*',
    excludePatterns = [],
    caseSensitive = false,
    maxResults = DEFAULT_MAX_RESULTS,
    maxFileSize = MAX_SEARCHABLE_FILE_SIZE,
    maxFilesScanned,
    timeoutMs,
    skipBinary = true,
    contextLines = 0,
    wholeWord = false,
    isLiteral = false,
    includeHidden = false,
  } = options;
  const validPath = await validateExistingPath(basePath);

  const deadlineMs =
    timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

  const { regex } = buildSearchRegex(searchPattern, {
    isLiteral,
    wholeWord,
    caseSensitive,
    basePath,
  });

  const matches: ContentMatch[] = [];
  let filesScanned = 0;
  let filesMatched = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  let skippedInaccessible = 0;
  let linesSkippedDueToRegexTimeout = 0;
  const stopState: {
    truncated: boolean;
    stoppedReason: SearchContentResult['summary']['stoppedReason'];
  } = { truncated: false, stoppedReason: undefined };

  const stream = fg.stream(filePattern, {
    cwd: validPath,
    absolute: true,
    onlyFiles: true,
    dot: includeHidden,
    ignore: excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  try {
    for await (const entry of stream) {
      const rawPath = typeof entry === 'string' ? entry : String(entry);
      const resolved = await resolveSearchPath(rawPath);
      if (!resolved) {
        skippedInaccessible++;
        continue;
      }
      const { openPath, displayPath } = resolved;

      const stopReason = getSearchStopReason(
        deadlineMs,
        maxFilesScanned,
        maxResults,
        filesScanned,
        matches.length
      );
      if (stopReason) {
        applySearchStop(stopReason, stopState);
        break;
      }

      try {
        const scanResult = await scanCandidateFile(
          openPath,
          displayPath,
          regex,
          {
            maxResults,
            currentMatchCount: matches.length,
            maxFileSize,
            skipBinary,
            isLiteral,
            searchPattern,
            caseSensitive,
            contextLines,
            wholeWord,
            deadlineMs,
          }
        );

        if (scanResult.scanned) {
          filesScanned++;
        }
        if (scanResult.skippedTooLarge) {
          skippedTooLarge++;
          continue;
        }
        if (scanResult.skippedBinary) {
          skippedBinary++;
          continue;
        }

        matches.push(...scanResult.matches);
        linesSkippedDueToRegexTimeout +=
          scanResult.linesSkippedDueToRegexTimeout;
        if (scanResult.fileHadMatches) filesMatched++;

        const postScanStopReason = getSearchStopReason(
          deadlineMs,
          maxFilesScanned,
          maxResults,
          filesScanned,
          matches.length
        );
        if (postScanStopReason) {
          applySearchStop(postScanStopReason, stopState);
          break;
        }
      } catch {
        skippedInaccessible++;
      }
    }
  } finally {
    // Ensure the stream is closed promptly on early exit
    const { destroy } = stream as { destroy?: () => void };
    if (typeof destroy === 'function') destroy.call(stream);
  }

  return {
    basePath: validPath,
    pattern: searchPattern,
    filePattern,
    matches,
    summary: {
      filesScanned,
      filesMatched,
      matches: matches.length,
      truncated: stopState.truncated,
      skippedTooLarge,
      skippedBinary,
      skippedInaccessible,
      linesSkippedDueToRegexTimeout,
      stoppedReason: stopState.stoppedReason,
    },
  };
}

export async function analyzeDirectory(
  dirPath: string,
  options: {
    maxDepth?: number;
    topN?: number;
    excludePatterns?: string[];
    includeHidden?: boolean;
  } = {}
): Promise<AnalyzeDirectoryResult> {
  const {
    maxDepth = DEFAULT_MAX_DEPTH,
    topN = DEFAULT_TOP_N,
    excludePatterns = [],
    includeHidden = false,
  } = options;
  const validPath = await validateExistingPath(dirPath);

  let totalFiles = 0;
  let totalDirectories = 0;
  let totalSize = 0;
  let currentMaxDepth = 0;
  let skippedInaccessible = 0;
  let symlinksNotFollowed = 0;
  const fileTypes: Record<string, number> = {};
  const largestFiles: { path: string; size: number }[] = [];
  const recentlyModified: { path: string; modified: Date }[] = [];

  const shouldExclude = createExcludeMatcher(excludePatterns);

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: validPath, depth: 0 }],
    async ({ currentPath, depth }, enqueue) => {
      if (depth > maxDepth) return;
      currentMaxDepth = Math.max(currentMaxDepth, depth);

      await forEachDirectoryEntry(
        currentPath,
        validPath,
        {
          includeHidden,
          shouldExclude,
          onInaccessible: () => {
            skippedInaccessible++;
          },
        },
        async ({ item, name, fullPath }) => {
          try {
            const validated = await validateExistingPathDetailed(fullPath);
            if (validated.isSymlink || item.isSymbolicLink()) {
              symlinksNotFollowed++;
              return;
            }

            const stats = await fs.stat(validated.resolvedPath);

            if (stats.isDirectory()) {
              totalDirectories++;
              if (depth + 1 <= maxDepth) {
                enqueue({
                  currentPath: validated.resolvedPath,
                  depth: depth + 1,
                });
              }
            } else if (stats.isFile()) {
              totalFiles++;
              totalSize += stats.size;

              const ext = path.extname(name).toLowerCase() || '(no extension)';
              fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;

              pushTopN(
                largestFiles,
                { path: validated.resolvedPath, size: stats.size },
                (a, b) => b.size - a.size,
                topN
              );
              pushTopN(
                recentlyModified,
                { path: validated.resolvedPath, modified: stats.mtime },
                (a, b) => b.modified.getTime() - a.modified.getTime(),
                topN
              );
            }
          } catch (error) {
            if (classifyAccessError(error) === 'symlink') {
              symlinksNotFollowed++;
            } else {
              skippedInaccessible++;
            }
          }
        }
      );
    },
    DIR_TRAVERSAL_CONCURRENCY
  );

  largestFiles.sort((a, b) => b.size - a.size);
  recentlyModified.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  const analysis: DirectoryAnalysis = {
    path: validPath,
    totalFiles,
    totalDirectories,
    totalSize,
    fileTypes,
    largestFiles,
    recentlyModified,
    maxDepth: currentMaxDepth,
  };

  return {
    analysis,
    summary: {
      truncated: false,
      skippedInaccessible,
      symlinksNotFollowed,
    },
  };
}

interface CollectedEntry {
  parentPath: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  depth: number;
}

function buildChildrenByParent(
  directoriesFound: Set<string>,
  collectedEntries: CollectedEntry[]
): Map<string, TreeEntry[]> {
  const childrenByParent = new Map<string, TreeEntry[]>();

  for (const dirPath of directoriesFound) {
    childrenByParent.set(dirPath, []);
  }

  for (const entry of collectedEntries) {
    const treeEntry: TreeEntry = {
      name: entry.name,
      type: entry.type,
    };
    if (entry.type === 'file' && entry.size !== undefined) {
      treeEntry.size = entry.size;
    }
    if (entry.type === 'directory') {
      const fullPath = path.join(entry.parentPath, entry.name);
      treeEntry.children = childrenByParent.get(fullPath) ?? [];
    }

    const siblings = childrenByParent.get(entry.parentPath);
    if (siblings) {
      siblings.push(treeEntry);
    }
  }

  return childrenByParent;
}

function sortTreeChildren(childrenByParent: Map<string, TreeEntry[]>): void {
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }
}

function buildTree(
  rootPath: string,
  childrenByParent: Map<string, TreeEntry[]>
): TreeEntry {
  const rootName = path.basename(rootPath);
  return {
    name: rootName || rootPath,
    type: 'directory',
    children: childrenByParent.get(rootPath) ?? [],
  };
}

export async function getDirectoryTree(
  dirPath: string,
  options: {
    maxDepth?: number;
    excludePatterns?: string[];
    includeHidden?: boolean;
    includeSize?: boolean;
    maxFiles?: number;
  } = {}
): Promise<DirectoryTreeResult> {
  const {
    maxDepth = DEFAULT_TREE_DEPTH,
    excludePatterns = [],
    includeHidden = false,
    includeSize = false,
    maxFiles,
  } = options;
  const validPath = await validateExistingPath(dirPath);

  const rootStats = await fs.stat(validPath);
  if (!rootStats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_DIRECTORY,
      `Not a directory: ${dirPath}`,
      dirPath
    );
  }

  let totalFiles = 0;
  let totalDirectories = 0;
  let maxDepthReached = 0;
  let skippedInaccessible = 0;
  let symlinksNotFollowed = 0;
  let truncated = false;

  const shouldExclude = createExcludeMatcher(excludePatterns);
  const effectiveMaxFiles = maxFiles ?? DEFAULT_TREE_MAX_FILES;

  const hitMaxFiles = (): boolean => {
    return totalFiles >= effectiveMaxFiles;
  };
  const shouldStop = (): boolean => {
    if (!hitMaxFiles()) return false;
    truncated = true;
    return true;
  };

  const collectedEntries: CollectedEntry[] = [];
  const directoriesFound = new Set<string>([validPath]);

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: validPath, depth: 0 }],
    async ({ currentPath, depth }, enqueue) => {
      if (hitMaxFiles()) {
        truncated = true;
        return;
      }
      if (depth > maxDepth) {
        truncated = true;
        return;
      }

      maxDepthReached = Math.max(maxDepthReached, depth);

      await forEachDirectoryEntry(
        currentPath,
        validPath,
        {
          includeHidden,
          shouldExclude,
          onInaccessible: () => {
            skippedInaccessible++;
          },
          shouldStop,
        },
        async ({ item, name, fullPath }) => {
          if (item.isSymbolicLink()) {
            symlinksNotFollowed++;
            return;
          }

          try {
            const { resolvedPath, isSymlink } =
              await validateExistingPathDetailed(fullPath);

            if (isSymlink) {
              symlinksNotFollowed++;
              return;
            }

            const stats = await fs.stat(resolvedPath);

            if (stats.isFile()) {
              totalFiles++;
              collectedEntries.push({
                parentPath: currentPath,
                name,
                type: 'file',
                size: includeSize ? stats.size : undefined,
                depth,
              });
            } else if (stats.isDirectory()) {
              totalDirectories++;
              directoriesFound.add(resolvedPath);
              collectedEntries.push({
                parentPath: currentPath,
                name,
                type: 'directory',
                depth,
              });

              if (depth + 1 <= maxDepth) {
                enqueue({ currentPath: resolvedPath, depth: depth + 1 });
              } else {
                truncated = true;
              }
            }
          } catch (error) {
            if (classifyAccessError(error) === 'symlink') {
              symlinksNotFollowed++;
            } else {
              skippedInaccessible++;
            }
          }
        }
      );
    },
    DIR_TRAVERSAL_CONCURRENCY
  );

  const childrenByParent = buildChildrenByParent(
    directoriesFound,
    collectedEntries
  );
  sortTreeChildren(childrenByParent);
  const tree = buildTree(validPath, childrenByParent);

  return {
    tree,
    summary: {
      totalFiles,
      totalDirectories,
      maxDepthReached,
      truncated,
      skippedInaccessible,
      symlinksNotFollowed,
    },
  };
}

export async function readMediaFile(
  filePath: string,
  { maxSize = MAX_MEDIA_FILE_SIZE }: { maxSize?: number } = {}
): Promise<MediaFileResult> {
  const validPath = await validateExistingPath(filePath);

  const stats = await fs.stat(validPath);
  const { size } = stats;

  if (!stats.isFile()) {
    throw new McpError(
      ErrorCode.E_NOT_FILE,
      `Not a file: ${filePath}`,
      filePath
    );
  }

  if (size > maxSize) {
    throw new McpError(
      ErrorCode.E_TOO_LARGE,
      `File too large: ${size} bytes (max: ${maxSize} bytes)`,
      filePath,
      { size, maxSize }
    );
  }

  const ext = path.extname(validPath).toLowerCase();
  const mimeType = getMimeType(ext);

  const buffer = await fs.readFile(validPath);
  const data = buffer.toString('base64');

  let width: number | undefined;
  let height: number | undefined;

  if (mimeType.startsWith('image/')) {
    const dimensions = parseImageDimensions(buffer, ext);
    if (dimensions) {
      ({ width, height } = dimensions);
    }
  }

  return {
    path: validPath,
    mimeType,
    size,
    data,
    width,
    height,
  };
}
