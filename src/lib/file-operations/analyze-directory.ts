import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type {
  AnalyzeDirectoryResult,
  DirectoryAnalysis,
} from '../../config/types.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_TOP_N,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { runWorkQueue } from '../fs-helpers.js';
import {
  validateExistingPath,
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

async function handleEntry(
  params: { currentPath: string; depth: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  state: AnalysisState,
  options: {
    basePath: string;
    maxDepth: number;
    topN: number;
    includeHidden: boolean;
    shouldExclude: (name: string, relativePath: string) => boolean;
  }
): Promise<void> {
  if (params.depth > options.maxDepth) return;
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
    },
    async ({ item, fullPath }) => {
      try {
        const validated = await validateExistingPathDetailed(fullPath);
        if (validated.isSymlink || item.isSymbolicLink()) {
          state.symlinksNotFollowed++;
          return;
        }

        const stats = await fs.stat(validated.resolvedPath);
        if (stats.isDirectory()) {
          state.totalDirectories++;
          if (params.depth + 1 <= options.maxDepth) {
            enqueue({
              currentPath: validated.resolvedPath,
              depth: params.depth + 1,
            });
          }
          return;
        }

        if (stats.isFile()) {
          updateFileStats(state, validated.resolvedPath, stats, options.topN);
        }
      } catch (error) {
        if (classifyAccessError(error) === 'symlink') {
          state.symlinksNotFollowed++;
        } else {
          state.skippedInaccessible++;
        }
      }
    }
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

  const basePath = await validateExistingPath(dirPath);
  const state = initAnalysisState();
  const shouldExclude = createExcludeMatcher(excludePatterns);

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleEntry(params, enqueue, state, {
        basePath,
        maxDepth,
        topN,
        includeHidden,
        shouldExclude,
      }),
    DIR_TRAVERSAL_CONCURRENCY
  );

  return {
    analysis: finalizeAnalysis(state, basePath),
    summary: {
      truncated: false,
      skippedInaccessible: state.skippedInaccessible,
      symlinksNotFollowed: state.symlinksNotFollowed,
    },
  };
}
