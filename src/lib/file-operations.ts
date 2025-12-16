import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import fg from 'fast-glob';
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
  DIR_TRAVERSAL_CONCURRENCY,
  getMimeType,
  MAX_MEDIA_FILE_SIZE,
  MAX_SEARCHABLE_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from './constants.js';
import {
  classifyAccessError,
  createExcludeMatcher,
  insertSorted,
} from './directory-helpers.js';
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
import { createSearchResultSorter, createSorter } from './sorting.js';

// Convert file mode to permission string (e.g., 'rwxr-xr-x')
function getPermissions(mode: number): string {
  // Permission strings indexed by octal value (0-7)
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

  // Bitwise mask guarantees indices 0-7
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
    if (maxEntries !== undefined && entries.length >= maxEntries) {
      truncated = true;
      return true;
    }
    return false;
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
        await processInParallel(
          visibleItems,
          async (
            item
          ): Promise<{
            entry: DirectoryEntry;
            enqueueDir?: { currentPath: string; depth: number };
          }> => {
            const fullPath = path.join(currentPath, item.name);
            const relativePath =
              path.relative(validPath, fullPath) || item.name;

            try {
              if (item.isSymbolicLink()) {
                symlinksNotFollowed++;
                const stats = await fs.lstat(fullPath);

                let symlinkTarget: string | undefined;
                if (includeSymlinkTargets) {
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
                return { entry };
              }

              const stats = await fs.stat(fullPath);
              const isDir = item.isDirectory();
              const type: FileType = isDir
                ? 'directory'
                : item.isFile()
                  ? 'file'
                  : getFileType(stats);

              const entry: DirectoryEntry = {
                name: item.name,
                path: fullPath,
                relativePath,
                type,
                size: type === 'file' ? stats.size : undefined,
                modified: stats.mtime,
              };

              const enqueueDir =
                recursive && isDir && depth + 1 <= maxDepth
                  ? {
                      currentPath: await validateExistingPath(fullPath),
                      depth: depth + 1,
                    }
                  : undefined;

              return { entry, enqueueDir };
            } catch {
              skippedInaccessible++;
              const entry: DirectoryEntry = {
                name: item.name,
                path: fullPath,
                relativePath,
                type: item.isDirectory()
                  ? 'directory'
                  : item.isFile()
                    ? 'file'
                    : 'other',
              };
              return { entry };
            }
          }
        );

      skippedInaccessible += processingErrors.length;

      for (const { entry, enqueueDir } of processedEntries) {
        if (stopIfNeeded()) break;
        entries.push(entry);
        if (entry.type === 'directory') totalDirectories++;
        if (entry.type === 'file') totalFiles++;
        if (enqueueDir) enqueue(enqueueDir);
      }
    },
    DIR_TRAVERSAL_CONCURRENCY
  );

  entries.sort(createSorter(sortBy));

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

  const batch: string[] = [];

  const flushBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const toProcess = batch.splice(0, batch.length);

    const settled = await Promise.allSettled(
      toProcess.map(async (match) => {
        // fast-glob operates within validated cwd with followSymbolicLinks:false,
        // so paths are already bounded - skip redundant validateExistingPath
        const stats = await fs.stat(match);
        const { size, mtime: modified } = stats;
        return {
          path: match,
          type: getFileType(stats),
          size: stats.isFile() ? size : undefined,
          modified,
        } satisfies SearchResult;
      })
    );

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        if (maxResults !== undefined && results.length >= maxResults) {
          truncated = true;
          break;
        }
        results.push(r.value);
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

  await flushBatch();

  results.sort(createSearchResultSorter(sortBy));

  return {
    basePath: validPath,
    pattern,
    results,
    summary: {
      matched: results.length,
      truncated,
      skippedInaccessible,
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

  if (filePaths.length === 0) return [];

  const output: { path: string; content?: string; error?: string }[] =
    filePaths.map((filePath) => ({ path: filePath }));

  // Pre-calculate total size to avoid race condition in parallel reads
  let totalSize = 0;
  const fileSizes = new Map<string, number>();

  for (const filePath of filePaths) {
    try {
      const validPath = await validateExistingPath(filePath);
      const stats = await fs.stat(validPath);
      fileSizes.set(filePath, stats.size);
      totalSize += stats.size;
    } catch {
      // Skip files we can't access - they'll error during read
      fileSizes.set(filePath, 0);
    }
  }

  if (totalSize > maxTotalSize) {
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
  } = options;
  const validPath = await validateExistingPath(basePath);

  const deadlineMs =
    timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;

  // Prepare the search pattern with optional literal escaping and word boundaries
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

  let regex: RegExp;
  try {
    regex = new RegExp(finalPattern, caseSensitive ? 'g' : 'gi');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Invalid regular expression: ${finalPattern} (${message})`,
      basePath,
      { searchPattern: finalPattern }
    );
  }

  const matches: ContentMatch[] = [];
  let filesScanned = 0;
  let filesMatched = 0;
  let skippedTooLarge = 0;
  let skippedBinary = 0;
  let skippedInaccessible = 0;
  let linesSkippedDueToRegexTimeout = 0;
  let truncated = false;
  let stoppedReason: SearchContentResult['summary']['stoppedReason'];
  let firstPathValidated = false;

  const stopNow = (reason: typeof stoppedReason): boolean => {
    truncated = true;
    stoppedReason = reason;
    return true;
  };

  const stream = fg.stream(filePattern, {
    cwd: validPath,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: excludePatterns,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  for await (const entry of stream) {
    const file = typeof entry === 'string' ? entry : String(entry);

    // Paranoid check: validate first result to detect unexpected fast-glob behavior
    if (!firstPathValidated) {
      try {
        await validateExistingPath(file);
        firstPathValidated = true;
      } catch {
        console.error('[SECURITY] fast-glob returned invalid path:', file);
        stopNow('maxFiles');
        break;
      }
    }

    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      stopNow('timeout');
      break;
    }
    if (maxFilesScanned !== undefined && filesScanned >= maxFilesScanned) {
      stopNow('maxFiles');
      break;
    }
    if (matches.length >= maxResults) {
      stopNow('maxResults');
      break;
    }

    try {
      // fast-glob operates within validated cwd with followSymbolicLinks:false,
      // so paths are already bounded - skip redundant validateExistingPath for glob results
      const handle = await fs.open(file, 'r');
      let shouldScan = true;

      try {
        const stats = await handle.stat();
        filesScanned++;

        if (stats.size > maxFileSize) {
          skippedTooLarge++;
          shouldScan = false;
        } else if (skipBinary) {
          const binary = await isProbablyBinary(file, handle);
          if (binary) {
            skippedBinary++;
            shouldScan = false;
          }
        }
      } finally {
        await handle.close().catch(() => {});
      }

      if (!shouldScan) continue;

      const scanResult = await scanFileForContent(file, regex, {
        maxResults,
        contextLines,
        deadlineMs,
        currentMatchCount: matches.length,
      });

      matches.push(...scanResult.matches);
      linesSkippedDueToRegexTimeout += scanResult.linesSkippedDueToRegexTimeout;
      if (scanResult.fileHadMatches) filesMatched++;

      if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        stopNow('timeout');
        break;
      }
      if (matches.length >= maxResults) {
        stopNow('maxResults');
        break;
      }

      if (stoppedReason !== undefined) break;
    } catch {
      skippedInaccessible++;
    }
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
      truncated,
      skippedTooLarge,
      skippedBinary,
      skippedInaccessible,
      linesSkippedDueToRegexTimeout,
      stoppedReason,
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

      let items;
      try {
        items = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        skippedInaccessible++;
        return;
      }

      for (const item of items) {
        const fullPath = path.join(currentPath, item.name);
        const relativePath = path.relative(validPath, fullPath);

        if (!includeHidden && isHidden(item.name)) {
          continue;
        }

        if (shouldExclude(item.name, relativePath)) {
          continue;
        }

        try {
          const validated = await validateExistingPathDetailed(fullPath);
          if (validated.isSymlink || item.isSymbolicLink()) {
            symlinksNotFollowed++;
            continue;
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

            const ext =
              path.extname(item.name).toLowerCase() || '(no extension)';
            fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;

            insertSorted(
              largestFiles,
              { path: validated.resolvedPath, size: stats.size },
              (a, b) => b.size - a.size,
              topN
            );
            insertSorted(
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
    },
    DIR_TRAVERSAL_CONCURRENCY
  );

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
    maxDepth = DEFAULT_MAX_DEPTH,
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

  const hitMaxFiles = (): boolean => {
    return maxFiles !== undefined && totalFiles >= maxFiles;
  };

  // Flat collection of all entries with parent tracking for tree assembly
  interface CollectedEntry {
    parentPath: string;
    name: string;
    type: 'file' | 'directory';
    size?: number;
    depth: number;
  }

  const collectedEntries: CollectedEntry[] = [];
  const directoriesFound = new Set<string>([validPath]);

  // Phase 1: Collect all entries using runWorkQueue for work-stealing concurrency
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

      let items;
      try {
        items = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        skippedInaccessible++;
        return;
      }

      for (const item of items) {
        if (hitMaxFiles()) {
          truncated = true;
          break;
        }

        const { name } = item;

        // Filter hidden files
        if (!includeHidden && name.startsWith('.')) {
          continue;
        }

        const fullPath = path.join(currentPath, name);
        const relativePath = path.relative(validPath, fullPath);

        // Check exclusion patterns
        if (shouldExclude(name, relativePath)) {
          continue;
        }

        // Handle symlinks - skip but count
        if (item.isSymbolicLink()) {
          symlinksNotFollowed++;
          continue;
        }

        try {
          // Validate path is within allowed directories
          const { resolvedPath, isSymlink } =
            await validateExistingPathDetailed(fullPath);

          if (isSymlink) {
            symlinksNotFollowed++;
            continue;
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

            // Enqueue subdirectory for traversal if not at max depth
            if (depth + 1 <= maxDepth) {
              enqueue({ currentPath: resolvedPath, depth: depth + 1 });
            } else {
              // Directory exists but we can't recurse due to depth limit
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
    },
    DIR_TRAVERSAL_CONCURRENCY
  );

  // Phase 2: Build tree structure from collected entries
  const childrenByParent = new Map<string, TreeEntry[]>();

  // Initialize all directories with empty children arrays
  for (const dirPath of directoriesFound) {
    childrenByParent.set(dirPath, []);
  }

  // Group entries by parent and create TreeEntry objects
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

  // Sort children: directories first, then alphabetically by name
  const sortChildren = (entries: TreeEntry[]): void => {
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  };

  for (const children of childrenByParent.values()) {
    sortChildren(children);
  }

  // Build root entry
  const rootName = path.basename(validPath);
  const tree: TreeEntry = {
    name: rootName || validPath,
    type: 'directory',
    children: childrenByParent.get(validPath) ?? [],
  };

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
