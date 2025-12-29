import type { ListDirectoryResult } from '../../config/types.js';
import {
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { createAbortError } from '../fs-helpers/abort.js';
import { mergeDefined } from '../merge-defined.js';
import { validateExistingDirectory } from '../path-validation.js';
import {
  createStopChecker,
  handleDirectory,
  initListState,
  type ListDirectoryConfig,
} from './list-directory-helpers.js';
import {
  buildExcludeMatchers,
  buildPatternMatcher,
} from './list-directory-matching.js';
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

type QueueWorker = (
  item: DirectoryQueueItem,
  enqueue: (item: DirectoryQueueItem) => void
) => Promise<void>;

async function runDirectoryQueue(
  initialItems: DirectoryQueueItem[],
  worker: QueueWorker,
  concurrency: number,
  signal?: AbortSignal
): Promise<void> {
  const queue = [...initialItems];
  let index = 0;
  const inFlight = new Set<Promise<void>>();
  const errors: Error[] = [];
  let aborted = Boolean(signal?.aborted);
  let abortListenerAttached = false;
  let abortResolve: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<void>((resolve) => {
        abortResolve = resolve;
        if (signal.aborted) resolve();
      })
    : undefined;

  if (aborted) throw createAbortError();

  const onAbort = (): void => {
    aborted = true;
    if (abortResolve) abortResolve();
  };
  if (signal && !signal.aborted) {
    signal.addEventListener('abort', onAbort, { once: true });
    abortListenerAttached = true;
  }

  try {
    while (index < queue.length || inFlight.size > 0) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (aborted) break;
      while (inFlight.size < concurrency && index < queue.length) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (aborted) break;
        const item = queue[index++];
        if (!item) break;
        const task = (async (): Promise<void> => {
          try {
            await worker(item, (next) => {
              if (!aborted) queue.push(next);
            });
          } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
            aborted = true;
          }
        })();
        inFlight.add(task);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        task.finally(() => inFlight.delete(task));
      }

      if (inFlight.size > 0) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (aborted) break;
        if (abortPromise) {
          await Promise.race([...inFlight, abortPromise]);
        } else {
          await Promise.race([...inFlight]);
        }
      }
    }
  } finally {
    if (abortListenerAttached) signal?.removeEventListener('abort', onAbort);
  }

  if (errors.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (errors.length === 1) throw errors[0]!;
    throw new AggregateError(errors, 'Work queue failed');
  }
  if (signal?.aborted) throw createAbortError();
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

function buildTraversalContext(
  basePath: string,
  normalized: NormalizedListDirectoryOptions,
  signal?: AbortSignal
): {
  config: ListDirectoryConfig;
  state: ReturnType<typeof initListState>;
  shouldStop: ReturnType<typeof createStopChecker>;
} {
  const state = initListState();
  const shouldStop = createStopChecker(normalized.maxEntries, state, signal);
  const excludeMatchers = buildExcludeMatchers(normalized.excludePatterns);
  const patternMatcher = buildPatternMatcher(normalized.pattern);

  return {
    config: {
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
    },
    state,
    shouldStop,
  };
}

export async function listDirectory(
  dirPath: string,
  options: ListDirectoryOptions = {}
): Promise<ListDirectoryResult> {
  const { signal, ...rest } = options;
  const normalized = normalizeListDirectoryOptions(rest);

  const basePath = await validateExistingDirectory(dirPath, signal);
  const { config, state, shouldStop } = buildTraversalContext(
    basePath,
    normalized,
    signal
  );

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
