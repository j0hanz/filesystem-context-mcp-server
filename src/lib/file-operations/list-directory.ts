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

interface QueueState {
  queue: DirectoryQueueItem[];
  index: number;
  aborted: boolean;
  abortReason?: Error;
  errors: Error[];
  inFlight: Set<Promise<void>>;
}

type QueueWorker = (
  item: DirectoryQueueItem,
  enqueue: (item: DirectoryQueueItem) => void
) => Promise<void>;

function createQueueState(
  initialItems: DirectoryQueueItem[],
  signal?: AbortSignal
): QueueState {
  return {
    queue: [...initialItems],
    index: 0,
    aborted: Boolean(signal?.aborted),
    abortReason: signal?.aborted ? createAbortError() : undefined,
    errors: [],
    inFlight: new Set<Promise<void>>(),
  };
}

function normalizeQueueError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function recordQueueError(state: QueueState, error: Error): void {
  state.errors.push(error);
  state.aborted = true;
  state.abortReason ??= error;
}

function attachAbortListener(
  state: QueueState,
  signal?: AbortSignal
): () => void {
  if (!signal || signal.aborted) return () => {};

  const onAbort = (): void => {
    if (state.aborted) return;
    state.aborted = true;
    state.abortReason = createAbortError();
  };

  signal.addEventListener('abort', onAbort, { once: true });

  return (): void => {
    signal.removeEventListener('abort', onAbort);
  };
}

function createAbortPromise(signal?: AbortSignal): Promise<void> | undefined {
  if (!signal) return undefined;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function enqueueItem(state: QueueState, item: DirectoryQueueItem): void {
  if (state.aborted) return;
  state.queue.push(item);
}

function canStartNext(state: QueueState, concurrency: number): boolean {
  return (
    !state.aborted &&
    state.inFlight.size < concurrency &&
    state.index < state.queue.length
  );
}

function createWorkerTask(
  state: QueueState,
  item: DirectoryQueueItem,
  worker: QueueWorker
): Promise<void> {
  return (async (): Promise<void> => {
    try {
      await worker(item, (next) => {
        enqueueItem(state, next);
      });
    } catch (error) {
      recordQueueError(state, normalizeQueueError(error));
    }
  })();
}

function queueNextTask(state: QueueState, worker: QueueWorker): void {
  const item = state.queue[state.index];
  state.index += 1;
  if (!item) return;

  const task = createWorkerTask(state, item, worker);
  state.inFlight.add(task);
  void task.finally(() => {
    state.inFlight.delete(task);
  });
}

function startNextTasks(
  state: QueueState,
  worker: QueueWorker,
  concurrency: number
): void {
  while (canStartNext(state, concurrency)) {
    queueNextTask(state, worker);
  }
}

async function drainQueue(
  state: QueueState,
  worker: QueueWorker,
  concurrency: number,
  abortPromise?: Promise<void>
): Promise<void> {
  startNextTasks(state, worker, concurrency);
  while (state.inFlight.size > 0) {
    if (state.aborted) return;
    const raceTargets = abortPromise
      ? [...state.inFlight, abortPromise]
      : [...state.inFlight];
    await Promise.race(raceTargets);
    startNextTasks(state, worker, concurrency);
  }
}

function throwIfQueueFailed(state: QueueState): void {
  if (state.errors.length === 1) {
    throw state.errors.at(0) ?? new Error('Work queue failed');
  }
  if (state.errors.length > 1) {
    throw new AggregateError(state.errors, 'Work queue failed');
  }
  if (state.abortReason) {
    throw state.abortReason;
  }
}

async function runDirectoryQueue(
  initialItems: DirectoryQueueItem[],
  worker: QueueWorker,
  concurrency: number,
  signal?: AbortSignal
): Promise<void> {
  const state = createQueueState(initialItems, signal);
  const abortPromise = createAbortPromise(signal);
  const detachAbort = attachAbortListener(state, signal);

  try {
    await drainQueue(state, worker, concurrency, abortPromise);
  } finally {
    detachAbort();
  }

  throwIfQueueFailed(state);
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
