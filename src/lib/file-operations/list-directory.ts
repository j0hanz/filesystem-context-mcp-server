import type { ListDirectoryResult } from '../../config/types.js';
import { DEFAULT_MAX_DEPTH, DIR_TRAVERSAL_CONCURRENCY } from '../constants.js';
import { runWorkQueue } from '../fs-helpers.js';
import { validateExistingPath } from '../path-validation.js';
import {
  createStopChecker,
  handleDirectory,
  initListState,
  type ListDirectoryConfig,
} from './list-directory-helpers.js';
import { sortByField } from './sorting.js';

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

  const basePath = await validateExistingPath(dirPath);
  const state = initListState();
  const shouldStop = createStopChecker(maxEntries, state);
  const config: ListDirectoryConfig = {
    basePath,
    recursive,
    includeHidden,
    maxDepth,
    maxEntries,
    includeSymlinkTargets,
  };

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleDirectory(params, enqueue, config, state, shouldStop),
    DIR_TRAVERSAL_CONCURRENCY
  );

  sortByField(state.entries, sortBy);

  return {
    path: basePath,
    entries: state.entries,
    summary: {
      totalEntries: state.entries.length,
      totalFiles: state.totalFiles,
      totalDirectories: state.totalDirectories,
      maxDepthReached: state.maxDepthReached,
      truncated: state.truncated,
      skippedInaccessible: state.skippedInaccessible,
      symlinksNotFollowed: state.symlinksNotFollowed,
    },
  };
}
