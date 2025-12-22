import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type {
  AnalyzeDirectoryResult,
  DirectoryAnalysis,
} from '../../config/types.js';
import {
  DEFAULT_ANALYZE_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_TOP_N,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { runWorkQueue } from '../fs-helpers.js';
import {
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../path-validation.js';
import {
  classifyAccessError,
  createExcludeMatcher,
  forEachDirectoryEntry,
} from './directory-helpers.js';

interface AnalysisState {
  totalFiles: number;
  totalDirectories: number;
  totalSize: number;
  currentMaxDepth: number;
  skippedInaccessible: number;
  symlinksNotFollowed: number;
  truncated: boolean;
  fileTypes: Record<string, number>;
  largestFiles: { path: string; size: number }[];
  recentlyModified: { path: string; modified: Date }[];
}

function initAnalysisState(): AnalysisState {
  return {
    totalFiles: 0,
    totalDirectories: 0,
    totalSize: 0,
    currentMaxDepth: 0,
    skippedInaccessible: 0,
    symlinksNotFollowed: 0,
    truncated: false,
    fileTypes: {},
    largestFiles: [],
    recentlyModified: [],
  };
}

function pushTopN<T>(
  arr: T[],
  item: T,
  compare: (a: T, b: T) => number,
  maxLen: number
): void {
  if (maxLen <= 0) return;
  arr.push(item);
  if (arr.length <= maxLen) return;
  arr.sort(compare);
  arr.length = maxLen;
}

function updateFileType(state: AnalysisState, filename: string): void {
  const ext = path.extname(filename).toLowerCase() || '(no extension)';
  state.fileTypes[ext] = (state.fileTypes[ext] ?? 0) + 1;
}

function updateFileStats(
  state: AnalysisState,
  filePath: string,
  stats: Stats,
  topN: number
): void {
  state.totalFiles++;
  state.totalSize += stats.size;

  updateFileType(state, filePath);

  pushTopN(
    state.largestFiles,
    { path: filePath, size: stats.size },
    (a, b) => b.size - a.size,
    topN
  );

  pushTopN(
    state.recentlyModified,
    { path: filePath, modified: stats.mtime },
    (a, b) => b.modified.getTime() - a.modified.getTime(),
    topN
  );
}

function shouldStop(state: AnalysisState, maxEntries: number): boolean {
  if (state.truncated) return true;
  if (state.totalFiles + state.totalDirectories >= maxEntries) {
    state.truncated = true;
    return true;
  }
  return false;
}

async function resolveEntryPath(
  fullPath: string,
  item: { isSymbolicLink: () => boolean },
  state: AnalysisState
): Promise<string | null> {
  try {
    const validated = await validateExistingPathDetailed(fullPath);
    if (validated.isSymlink || item.isSymbolicLink()) {
      state.symlinksNotFollowed++;
      return null;
    }
    return validated.resolvedPath;
  } catch (error) {
    if (classifyAccessError(error) === 'symlink') {
      state.symlinksNotFollowed++;
    } else {
      state.skippedInaccessible++;
    }
    return null;
  }
}

function enqueueChildDirectory(
  resolvedPath: string,
  depth: number,
  options: { maxDepth: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void
): void {
  if (depth + 1 > options.maxDepth) return;
  enqueue({ currentPath: resolvedPath, depth: depth + 1 });
}

function handleDirectoryStats(
  resolvedPath: string,
  depth: number,
  state: AnalysisState,
  options: { maxDepth: number; maxEntries: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void
): void {
  state.totalDirectories++;
  if (shouldStop(state, options.maxEntries)) return;
  enqueueChildDirectory(resolvedPath, depth, options, enqueue);
}

function handleFileStats(
  resolvedPath: string,
  stats: Stats,
  state: AnalysisState,
  options: { topN: number; maxEntries: number }
): void {
  updateFileStats(state, resolvedPath, stats, options.topN);
  shouldStop(state, options.maxEntries);
}

async function processDirectoryEntry(
  params: { currentPath: string; depth: number },
  entry: { item: { isSymbolicLink: () => boolean }; fullPath: string },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  state: AnalysisState,
  options: {
    maxDepth: number;
    topN: number;
    maxEntries: number;
  }
): Promise<void> {
  if (shouldStop(state, options.maxEntries)) return;

  const resolvedPath = await resolveEntryPath(
    entry.fullPath,
    entry.item,
    state
  );
  if (!resolvedPath) return;

  const stats = await fs.stat(resolvedPath);
  if (stats.isDirectory()) {
    handleDirectoryStats(resolvedPath, params.depth, state, options, enqueue);
    return;
  }

  if (stats.isFile()) {
    handleFileStats(resolvedPath, stats, state, options);
  }
}

async function handleEntry(
  params: { currentPath: string; depth: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  state: AnalysisState,
  options: {
    basePath: string;
    maxDepth: number;
    topN: number;
    maxEntries: number;
    includeHidden: boolean;
    shouldExclude: (name: string, relativePath: string) => boolean;
  }
): Promise<void> {
  if (params.depth > options.maxDepth) return;
  if (shouldStop(state, options.maxEntries)) return;
  state.currentMaxDepth = Math.max(state.currentMaxDepth, params.depth);

  await forEachDirectoryEntry(
    params.currentPath,
    options.basePath,
    {
      includeHidden: options.includeHidden,
      shouldExclude: options.shouldExclude,
      onInaccessible: () => {
        state.skippedInaccessible++;
      },
      shouldStop: () => shouldStop(state, options.maxEntries),
    },
    async ({ item, fullPath }) =>
      processDirectoryEntry(params, { item, fullPath }, enqueue, state, options)
  );
}

function finalizeAnalysis(
  state: AnalysisState,
  basePath: string
): DirectoryAnalysis {
  state.largestFiles.sort((a, b) => b.size - a.size);
  state.recentlyModified.sort(
    (a, b) => b.modified.getTime() - a.modified.getTime()
  );

  return {
    path: basePath,
    totalFiles: state.totalFiles,
    totalDirectories: state.totalDirectories,
    totalSize: state.totalSize,
    fileTypes: state.fileTypes,
    largestFiles: state.largestFiles,
    recentlyModified: state.recentlyModified,
    maxDepth: state.currentMaxDepth,
  };
}

export async function analyzeDirectory(
  dirPath: string,
  options: {
    maxDepth?: number;
    topN?: number;
    maxEntries?: number;
    excludePatterns?: string[];
    includeHidden?: boolean;
  } = {}
): Promise<AnalyzeDirectoryResult> {
  const normalized = normalizeAnalyzeOptions(options);
  const basePath = await validateExistingDirectory(dirPath);
  const state = initAnalysisState();
  const shouldExclude = createExcludeMatcher(normalized.excludePatterns);

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleEntry(params, enqueue, state, {
        basePath,
        maxDepth: normalized.maxDepth,
        topN: normalized.topN,
        maxEntries: normalized.maxEntries,
        includeHidden: normalized.includeHidden,
        shouldExclude,
      }),
    DIR_TRAVERSAL_CONCURRENCY
  );

  return {
    analysis: finalizeAnalysis(state, basePath),
    summary: {
      truncated: state.truncated,
      skippedInaccessible: state.skippedInaccessible,
      symlinksNotFollowed: state.symlinksNotFollowed,
    },
  };
}

function normalizeAnalyzeOptions(options: {
  maxDepth?: number;
  topN?: number;
  maxEntries?: number;
  excludePatterns?: string[];
  includeHidden?: boolean;
}): {
  maxDepth: number;
  topN: number;
  maxEntries: number;
  excludePatterns: string[];
  includeHidden: boolean;
} {
  const defaults = {
    maxDepth: DEFAULT_MAX_DEPTH,
    topN: DEFAULT_TOP_N,
    maxEntries: DEFAULT_ANALYZE_MAX_ENTRIES,
    excludePatterns: [] as string[],
    includeHidden: false,
  };
  return mergeDefined(defaults, options);
}

function mergeDefined<T extends object>(defaults: T, overrides: Partial<T>): T {
  const entries = Object.entries(overrides).filter(
    ([, value]) => value !== undefined
  );
  const merged: T = {
    ...defaults,
    ...(Object.fromEntries(entries) as Partial<T>),
  };
  return merged;
}
