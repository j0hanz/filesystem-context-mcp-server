import type { ListDirectoryResult } from '../../config/types.js';
import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { mergeDefined } from '../merge-defined.js';
import { validateExistingDirectory } from '../path-validation.js';
import {
  buildExcludeMatchers,
  buildPatternMatcher,
  createStopChecker,
  handleDirectory,
  initListState,
  type ListDirectoryConfig,
} from './list-directory-helpers.js';
import { sortByField } from './sorting.js';

interface ListDirectoryOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  excludePatterns?: string[];
  maxDepth?: number;
  maxEntries?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'type';
  includeSymlinkTargets?: boolean;
  pattern?: string;
  signal?: AbortSignal;
}

type NormalizedListDirectoryOptions = Required<
  Omit<ListDirectoryOptions, 'signal'>
>;

interface DirectoryQueueItem {
  currentPath: string;
  depth: number;
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

async function runDirectoryQueue(
  initialItems: DirectoryQueueItem[],
  worker: (
    item: DirectoryQueueItem,
    enqueue: (item: DirectoryQueueItem) => void
  ) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal
): Promise<void> {
  const queue: DirectoryQueueItem[] = [...initialItems];
  let index = 0;
  let aborted = Boolean(signal?.aborted);
  let abortReason: Error | undefined = aborted ? createAbortError() : undefined;
  const errors: Error[] = [];
  const inFlight = new Set<Promise<void>>();

  const onAbort = (): void => {
    if (!aborted) {
      aborted = true;
      abortReason = createAbortError();
    }
  };

  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const enqueue = (item: DirectoryQueueItem): void => {
    if (aborted) return;
    queue.push(item);
  };

  const startNext = (): void => {
    while (!aborted && inFlight.size < concurrency && index < queue.length) {
      const item = queue.at(index);
      index += 1;
      if (!item) break;
      const task = (async (): Promise<void> => {
        try {
          await worker(item, enqueue);
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          errors.push(normalized);
          aborted = true;
          abortReason ??= normalized;
        }
      })();
      inFlight.add(task);
      void task.finally(() => {
        inFlight.delete(task);
      });
    }
  };

  startNext();
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    startNext();
  }

  if (signal) {
    signal.removeEventListener('abort', onAbort);
  }

  if (errors.length === 1) {
    const [firstError] = errors;
    if (firstError) {
      throw firstError;
    }
    throw new Error('Work queue failed');
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Work queue failed');
  }
  if (abortReason) {
    throw abortReason;
  }
}

function normalizeListDirectoryOptions(
  options: Omit<ListDirectoryOptions, 'signal'>
): NormalizedListDirectoryOptions {
  const defaults: NormalizedListDirectoryOptions = {
    recursive: false,
    includeHidden: false,
    excludePatterns: [],
    maxDepth: DEFAULT_MAX_DEPTH,
    maxEntries: DEFAULT_LIST_MAX_ENTRIES,
    sortBy: 'name',
    includeSymlinkTargets: false,
    pattern: '',
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
    stoppedReason: state.stoppedReason,
    skippedInaccessible: state.skippedInaccessible,
    symlinksNotFollowed: state.symlinksNotFollowed,
    entriesScanned: state.entriesScanned,
    entriesVisible: state.entriesVisible,
  };
}

export async function listDirectory(
  dirPath: string,
  options: ListDirectoryOptions = {}
): Promise<ListDirectoryResult> {
  const { signal, ...rest } = options;
  const normalized = normalizeListDirectoryOptions(rest);

  const basePath = await validateExistingDirectory(dirPath);
  const state = initListState();
  const shouldStop = createStopChecker(normalized.maxEntries, state, signal);
  const excludeMatchers = buildExcludeMatchers(normalized.excludePatterns);
  const patternMatcher = buildPatternMatcher(normalized.pattern);
  const config: ListDirectoryConfig = {
    basePath,
    recursive: normalized.recursive,
    includeHidden: normalized.includeHidden,
    excludePatterns: normalized.excludePatterns,
    excludeMatchers,
    maxDepth: normalized.maxDepth,
    maxEntries: normalized.maxEntries,
    includeSymlinkTargets: normalized.includeSymlinkTargets,
    pattern: normalized.pattern,
    patternMatcher,
    signal,
  };

  await runDirectoryQueue(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleDirectory(params, enqueue, config, state, shouldStop),
    DIR_TRAVERSAL_CONCURRENCY,
    signal
  );

  sortByField(state.entries, normalized.sortBy);

  return {
    path: basePath,
    entries: state.entries,
    summary: buildSummary(state),
  };
}
