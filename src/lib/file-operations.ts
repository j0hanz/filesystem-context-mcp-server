import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { createReadStream } from 'node:fs';

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
  DIR_TRAVERSAL_CONCURRENCY,
  getMimeType,
  MAX_LINE_CONTENT_LENGTH,
  MAX_MEDIA_FILE_SIZE,
  MAX_SEARCHABLE_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
  REGEX_MATCH_TIMEOUT_MS,
} from './constants.js';
import { ErrorCode, McpError } from './errors.js';
import {
  getFileType,
  isHidden,
  isProbablyBinary,
  readFile,
  runWorkQueue,
} from './fs-helpers.js';
import { parseImageDimensions } from './image-parsing.js';
import {
  validateExistingPath,
  validateExistingPathDetailed,
} from './path-validation.js';

// Create matcher from exclude patterns
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

interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

// Process items in parallel with controlled concurrency
async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY
): Promise<ParallelResult<R>> {
  const results: R[] = [];
  const errors: { index: number; error: Error }[] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(processor));

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j];
      if (result?.status === 'fulfilled') {
        results.push(result.value);
      } else if (result?.status === 'rejected') {
        const globalIndex = i + j;
        const error =
          result.reason instanceof Error
            ? result.reason
            : new Error(String(result.reason));
        errors.push({ index: globalIndex, error });
      }
    }
  }

  return { results, errors };
}

// Count regex matches with timeout protection (returns -1 on timeout)
function countRegexMatches(
  line: string,
  regex: RegExp,
  timeoutMs: number = REGEX_MATCH_TIMEOUT_MS
): number {
  // Safety check for empty line
  if (line.length === 0) return 0;

  regex.lastIndex = 0;
  let count = 0;
  const deadline = Date.now() + timeoutMs;
  const maxIterations = line.length * 2; // Prevent infinite loops
  let iterations = 0;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    count++;
    iterations++;

    // Prevent infinite loops on zero-width matches
    if (match[0] === '') {
      regex.lastIndex++;
      // Prevent advancing beyond string length
      if (regex.lastIndex > line.length) break;
    }

    // Check timeout periodically
    if (count % 100 === 0 && Date.now() > deadline) {
      console.error(
        `[countRegexMatches] Regex matching timed out after ${timeoutMs}ms on line (length: ${line.length})`
      );
      return -1; // Signal timeout
    }

    // Safety check for runaway regex
    if (iterations > maxIterations) {
      console.error(
        `[countRegexMatches] Max iterations exceeded (${maxIterations}) on line (length: ${line.length})`
      );
      return -1; // Signal runaway regex
    }
  }

  return count;
}

// Check if regex is simple enough to be safe
function isSimpleSafePattern(pattern: string): boolean {
  // Validate input
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return false;
  }

  // Patterns with nested quantifiers are the main ReDoS concern
  const nestedQuantifierPattern = /[+*?}]\s*\)\s*[+*?{]/;
  if (nestedQuantifierPattern.test(pattern)) {
    return false;
  }

  // Check for high repetition counts that safe-regex2 would flag (default limit is 25)
  const highRepetitionPattern = /\{(\d+)(?:,\d*)?\}/g;
  let match;
  while ((match = highRepetitionPattern.exec(pattern)) !== null) {
    const countStr = match[1];
    if (countStr === undefined) continue;

    const count = parseInt(countStr, 10);
    // Check for NaN and high values
    if (Number.isNaN(count) || count >= 25) {
      return false;
    }
  }

  return true;
}

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

  // Use bitwise operations and bounds-checked array access
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
      } catch (error) {
        skippedInaccessible++;
        const { code } = error as NodeJS.ErrnoException;
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
          console.error(
            `[listDirectory] Error reading directory ${currentPath}:`,
            error
          );
        }
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

  entries.sort((a, b) => {
    switch (sortBy) {
      case 'size':
        return (b.size ?? 0) - (a.size ?? 0);
      case 'modified':
        return (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0);
      case 'type':
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      case 'name':
      default:
        return a.name.localeCompare(b.name);
    }
  });

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
        const validMatch = await validateExistingPath(match);
        const stats = await fs.stat(validMatch);
        const { size, mtime: modified } = stats;
        return {
          path: validMatch,
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

  results.sort((a, b) => {
    switch (sortBy) {
      case 'size':
        return (b.size ?? 0) - (a.size ?? 0);
      case 'modified':
        return (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0);
      case 'name':
        return path.basename(a.path).localeCompare(path.basename(b.path));
      case 'path':
      default:
        return a.path.localeCompare(b.path);
    }
  });

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
    head?: number;
    tail?: number;
  } = {}
): Promise<{ path: string; content?: string; error?: string }[]> {
  const {
    encoding = 'utf-8',
    maxSize = MAX_TEXT_FILE_SIZE,
    head,
    tail,
  } = options;

  if (filePaths.length === 0) return [];

  const output: { path: string; content?: string; error?: string }[] =
    filePaths.map((filePath) => ({ path: filePath }));

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

  let finalPattern = searchPattern;

  if (isLiteral) {
    finalPattern = finalPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  if (wholeWord) {
    finalPattern = `\\b${finalPattern}\\b`;
  }

  const needsReDoSCheck = !isLiteral && !isSimpleSafePattern(finalPattern);

  if (needsReDoSCheck && !safeRegex(finalPattern)) {
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Potentially unsafe regular expression (ReDoS risk): ${searchPattern}. ` +
        'Avoid patterns with nested quantifiers, overlapping alternations, or exponential backtracking.',
      basePath,
      {
        searchPattern,
        finalPattern,
        reason: 'ReDoS risk detected by safe-regex2',
      }
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

  // Circular buffer to hold context lines before a match
  class CircularLineBuffer {
    private buffer: string[];
    private writeIndex = 0;
    private count = 0;

    constructor(private capacity: number) {
      this.buffer = new Array<string>(capacity);
    }

    push(line: string): void {
      this.buffer[this.writeIndex] = line;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      if (this.count < this.capacity) this.count++;
    }

    toArray(): string[] {
      if (this.count === 0) return [];
      if (this.count < this.capacity) {
        return this.buffer.slice(0, this.count);
      }
      // Buffer is full - return in correct order starting from writeIndex
      return [
        ...this.buffer.slice(this.writeIndex),
        ...this.buffer.slice(0, this.writeIndex),
      ];
    }
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

    let validFile: string;
    let handle: fs.FileHandle | undefined;
    try {
      validFile = await validateExistingPath(file);
      handle = await fs.open(validFile, 'r');
      const stats = await handle.stat();

      filesScanned++;

      if (stats.size > maxFileSize) {
        skippedTooLarge++;
        await handle.close();
        handle = undefined;
        continue;
      }

      if (skipBinary) {
        const binary = await isProbablyBinary(validFile, handle);
        if (binary) {
          skippedBinary++;
          await handle.close();
          handle = undefined;
          continue;
        }
      }

      await handle.close();
      handle = undefined;

      const fileStream = createReadStream(validFile, {
        encoding: 'utf-8',
      });

      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let fileHadMatches = false;
      let lineNumber = 0;
      const lineBuffer =
        contextLines > 0 ? new CircularLineBuffer(contextLines) : null;
      const pendingMatches: { match: ContentMatch; afterNeeded: number }[] = [];

      try {
        for await (const line of rl) {
          lineNumber++;

          if (deadlineMs !== undefined && Date.now() > deadlineMs) {
            stopNow('timeout');
            break;
          }
          if (matches.length >= maxResults) {
            stopNow('maxResults');
            break;
          }

          const trimmedLine = line.trim().substring(0, MAX_LINE_CONTENT_LENGTH);

          for (const pending of pendingMatches) {
            if (pending.afterNeeded > 0) {
              pending.match.contextAfter ??= [];
              pending.match.contextAfter.push(trimmedLine);
              pending.afterNeeded--;
            }
          }
          while (
            pendingMatches.length > 0 &&
            pendingMatches[0]?.afterNeeded === 0
          ) {
            pendingMatches.shift();
          }

          const matchCount = countRegexMatches(line, regex);
          if (matchCount < 0) {
            linesSkippedDueToRegexTimeout++;
            console.error(
              `[searchContent] Skipping line ${lineNumber} in ${validFile} due to regex timeout`
            );
            if (lineBuffer) {
              lineBuffer.push(trimmedLine);
            }
            continue;
          }
          if (matchCount > 0) {
            fileHadMatches = true;
            const newMatch: ContentMatch = {
              file: validFile,
              line: lineNumber,
              content: trimmedLine,
              matchCount,
            };

            const contextBefore = lineBuffer?.toArray();
            if (contextBefore && contextBefore.length > 0) {
              newMatch.contextBefore = contextBefore;
            }

            matches.push(newMatch);

            if (contextLines > 0) {
              pendingMatches.push({
                match: newMatch,
                afterNeeded: contextLines,
              });
            }
          }

          if (lineBuffer) {
            lineBuffer.push(trimmedLine);
          }
        }
      } finally {
        rl.close();
        fileStream.destroy();
      }

      if (fileHadMatches) filesMatched++;

      if (stoppedReason !== undefined) break;
    } catch {
      if (handle) {
        await handle.close().catch(() => {});
      }
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

  const insertSorted = <T>(
    arr: T[],
    item: T,
    compare: (a: T, b: T) => boolean,
    maxLen: number
  ): void => {
    if (maxLen <= 0) return;
    const idx = arr.findIndex((el) => compare(item, el));
    if (idx === -1) {
      if (arr.length < maxLen) arr.push(item);
    } else {
      arr.splice(idx, 0, item);
      if (arr.length > maxLen) arr.pop();
    }
  };

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: validPath, depth: 0 }],
    async ({ currentPath, depth }, enqueue) => {
      if (depth > maxDepth) return;
      currentMaxDepth = Math.max(currentMaxDepth, depth);

      let items;
      try {
        items = await fs.readdir(currentPath, { withFileTypes: true });
      } catch (error) {
        skippedInaccessible++;
        const { code } = error as NodeJS.ErrnoException;
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
          console.error(
            `[analyzeDirectory] Error reading directory ${currentPath}:`,
            error
          );
        }
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
              (a, b) => a.size > b.size,
              topN
            );
            insertSorted(
              recentlyModified,
              { path: validated.resolvedPath, modified: stats.mtime },
              (a, b) => a.modified.getTime() > b.modified.getTime(),
              topN
            );
          }
        } catch (error) {
          if (
            error instanceof McpError &&
            (error.code === ErrorCode.E_ACCESS_DENIED ||
              error.code === ErrorCode.E_SYMLINK_NOT_ALLOWED)
          ) {
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

  const buildTree = async (
    currentPath: string,
    depth: number,
    relativePath = ''
  ): Promise<TreeEntry | null> => {
    if (hitMaxFiles()) {
      truncated = true;
      return null;
    }

    let validatedPath: string;
    let isSymlink = false;
    try {
      ({ resolvedPath: validatedPath, isSymlink } =
        await validateExistingPathDetailed(currentPath));
    } catch (error) {
      if (
        error instanceof McpError &&
        (error.code === ErrorCode.E_ACCESS_DENIED ||
          error.code === ErrorCode.E_SYMLINK_NOT_ALLOWED)
      ) {
        symlinksNotFollowed++;
      } else {
        skippedInaccessible++;
      }
      return null;
    }

    const name = path.basename(validatedPath);

    if (shouldExclude(name, relativePath)) {
      return null;
    }

    if (!includeHidden && name.startsWith('.') && relativePath !== '') {
      return null;
    }

    maxDepthReached = Math.max(maxDepthReached, depth);

    if (isSymlink) {
      symlinksNotFollowed++;
      return null;
    }

    let stats;
    try {
      stats = await fs.stat(validatedPath);
    } catch {
      skippedInaccessible++;
      return null;
    }

    const { size } = stats;

    if (stats.isFile()) {
      if (hitMaxFiles()) {
        truncated = true;
        return null;
      }
      totalFiles++;
      const entry: TreeEntry = { name, type: 'file' };
      if (includeSize) {
        entry.size = size;
      }
      return entry;
    }

    if (stats.isDirectory()) {
      totalDirectories++;

      if (depth >= maxDepth) {
        truncated = true;
        return { name, type: 'directory', children: [] };
      }

      let items;
      try {
        items = await fs.readdir(validatedPath, { withFileTypes: true });
      } catch {
        skippedInaccessible++;
        return { name, type: 'directory', children: [] };
      }

      const children: TreeEntry[] = [];
      for (
        let i = 0;
        i < items.length && !hitMaxFiles();
        i += DIR_TRAVERSAL_CONCURRENCY
      ) {
        const batch = items.slice(i, i + DIR_TRAVERSAL_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map((item) => {
            const childPath = path.join(validatedPath, item.name);
            const childRelative = relativePath
              ? `${relativePath}/${item.name}`
              : item.name;
            return buildTree(childPath, depth + 1, childRelative);
          })
        );
        for (const entry of batchResults) {
          if (entry !== null) {
            children.push(entry);
          }
        }
      }

      children.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return { name, type: 'directory', children };
    }

    return null;
  };

  const tree = await buildTree(validPath, 0);

  if (!tree) {
    throw new McpError(
      ErrorCode.E_UNKNOWN,
      `Unable to build tree for path: ${dirPath}`,
      dirPath
    );
  }

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
  options: {
    maxSize?: number;
  } = {}
): Promise<MediaFileResult> {
  const { maxSize = MAX_MEDIA_FILE_SIZE } = options;
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
