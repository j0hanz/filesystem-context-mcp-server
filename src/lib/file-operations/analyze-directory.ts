import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import type { AnalyzeDirectoryResult } from '../../config/types.js';
import {
  DEFAULT_ANALYZE_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_TOP_N,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { runWorkQueue } from '../fs-helpers.js';
import { mergeDefined } from '../merge-defined.js';
import {
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../path-validation.js';
import {
  type AnalysisState,
  finalizeAnalysis,
  initAnalysisState,
  updateFileStats,
} from './analyze-directory-helpers.js';
import {
  classifyAccessError,
  createExcludeMatcher,
  forEachDirectoryEntry,
} from './directory-helpers.js';

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

export async function analyzeDirectory(
  dirPath: string,
  options: {
    maxDepth?: number;
    topN?: number;
    maxEntries?: number;
    excludePatterns?: string[];
    includeHidden?: boolean;
    signal?: AbortSignal;
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
    DIR_TRAVERSAL_CONCURRENCY,
    options.signal
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
