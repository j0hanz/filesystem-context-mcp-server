import type { ListDirectoryResult } from '../../config/types.js';
import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { runWorkQueue } from '../fs-helpers.js';
import { validateExistingDirectory } from '../path-validation.js';
import {
  createStopChecker,
  handleDirectory,
  initListState,
  type ListDirectoryConfig,
} from './list-directory-helpers.js';
import { sortByField } from './sorting.js';

interface ListDirectoryOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'type';
  includeSymlinkTargets?: boolean;
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

function normalizeListDirectoryOptions(
  options: ListDirectoryOptions
): Required<ListDirectoryOptions> {
  const defaults: Required<ListDirectoryOptions> = {
    recursive: false,
    includeHidden: false,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEntries: DEFAULT_LIST_MAX_ENTRIES,
    sortBy: 'name',
    includeSymlinkTargets: false,
  };
  return mergeDefined(defaults, options);
}

function buildSummary(
  state: ReturnType<typeof initListState>
): ListDirectoryResult['summary'] {
  return {
    totalEntries: state.entries.length,
    totalFiles: state.totalFiles,
    totalDirectories: state.totalDirectories,
    maxDepthReached: state.maxDepthReached,
    truncated: state.truncated,
    skippedInaccessible: state.skippedInaccessible,
    symlinksNotFollowed: state.symlinksNotFollowed,
  };
}

export async function listDirectory(
  dirPath: string,
  options: ListDirectoryOptions = {}
): Promise<ListDirectoryResult> {
  const normalized = normalizeListDirectoryOptions(options);

  const basePath = await validateExistingDirectory(dirPath);
  const state = initListState();
  const shouldStop = createStopChecker(normalized.maxEntries, state);
  const config: ListDirectoryConfig = {
    basePath,
    recursive: normalized.recursive,
    includeHidden: normalized.includeHidden,
    maxDepth: normalized.maxDepth,
    maxEntries: normalized.maxEntries,
    includeSymlinkTargets: normalized.includeSymlinkTargets,
  };

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleDirectory(params, enqueue, config, state, shouldStop),
    DIR_TRAVERSAL_CONCURRENCY
  );

  sortByField(state.entries, normalized.sortBy);

  return {
    path: basePath,
    entries: state.entries,
    summary: buildSummary(state),
  };
}
