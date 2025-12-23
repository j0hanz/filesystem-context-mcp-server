import * as path from 'node:path';
import type { Stats } from 'node:fs';

import type { DirectoryAnalysis } from '../../config/types.js';

export interface AnalysisState {
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

export function initAnalysisState(): AnalysisState {
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

export function updateFileStats(
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

export function finalizeAnalysis(
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
