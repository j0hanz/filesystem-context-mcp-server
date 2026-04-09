import {
  type Dirent,
  lstat,
  readdir,
  readlink,
  stat,
  type Stats,
} from 'node:fs';
import { basename, join, parse, relative } from 'node:path';

import type {
  DirectoryEntry,
  FileInfo,
  GetMultipleFileInfoResult,
  ListDirectoryResult,
  MultipleFileInfoResult,
} from '../../config.js';
import { assertNotAborted, withAbort, withTimedAbortSignal } from '../abort.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  DEFAULT_SEARCH_TIMEOUT_MS,
  getMimeType,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../constants.js';
import { isAbortError } from '../errors.js';
import {
  getFileType,
  isHidden,
  processInParallel,
  readFile,
  readFileWithStats,
} from '../fs-helpers.js';
import { assertSafeGlobPattern } from '../globs.js';
import {
  assertAllowedFileAccess,
  isPathWithinDirectories,
  isSensitivePath,
  normalizePath,
  toPosixPath,
  validateExistingDirectory,
  validateExistingPath,
  validateExistingPathDetailed,
} from '../paths.js';
import {
  applyIndexedErrors,
  applyIndexedValues,
  type DirentLike,
  type EntryAccessDependencies,
  type EntryType,
  isEntryAccessibleByType,
  isIgnoredByGitignore,
  loadRootGitignore,
  needsStatsForSort,
  resolveEntryType,
  resolveStopReason,
  withOptionalStoppedReason,
} from './core.js';
import { globEntries } from './traversal.js';

function statAsync(filePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    stat(filePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function readlinkAsync(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    readlink(filePath, (err, linkString) => {
      if (err) reject(err);
      else resolve(linkString);
    });
  });
}

function readdirAsync(
  dirPath: string,
  options: { withFileTypes: true }
): Promise<Dirent[]> {
  return new Promise((resolve, reject) => {
    readdir(dirPath, options, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });
}

function lstatAsync(filePath: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    lstat(filePath, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

const ACCESS_DEPS: EntryAccessDependencies = {
  normalizePath,
  isPathWithinDirectories,
  isSensitivePath,
  validateSymlinkPath: validateExistingPathDetailed,
};

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

interface FileInfoOptions {
  includeMimeType?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: () => void;
}

const UNKNOWN_PATH = '(unknown)';

function getPermissions(mode: number): string {
  return (
    (PERM_STRINGS[(mode >> 6) & 0b111] ?? '---') +
    (PERM_STRINGS[(mode >> 3) & 0b111] ?? '---') +
    (PERM_STRINGS[mode & 0b111] ?? '---')
  );
}

function buildFileInfoResult(
  name: string,
  requestedPath: string,
  isSymlink: boolean,
  stats: Stats,
  mimeType: string | undefined,
  symlinkTarget: string | undefined
): FileInfo {
  const tokenEstimate = stats.isFile() ? Math.ceil(stats.size / 4) : undefined;
  return {
    name,
    path: requestedPath,
    type: isSymlink ? 'symlink' : getFileType(stats),
    size: stats.size,
    ...(tokenEstimate !== undefined ? { tokenEstimate } : {}),
    created: stats.birthtime,
    modified: stats.mtime,
    accessed: stats.atime,
    permissions: getPermissions(stats.mode),
    isHidden: isHidden(name),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

async function getSymlinkTarget(
  pathToRead: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  assertNotAborted(signal);
  try {
    return await withAbort(readlinkAsync(pathToRead), signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return undefined;
  }
}

export async function getFileInfo(
  filePath: string,
  options: FileInfoOptions = {}
): Promise<FileInfo> {
  const { signal } = options;
  assertNotAborted(signal);

  const { requestedPath, resolvedPath, isSymlink } =
    await validateExistingPathDetailed(filePath, signal);

  assertAllowedFileAccess(requestedPath, resolvedPath);

  const { base: name, ext: rawExt } = parse(requestedPath);
  const ext = rawExt.toLowerCase();
  const includeMimeType = options.includeMimeType !== false;
  const mimeType =
    includeMimeType && ext.length > 0 ? getMimeType(ext) : undefined;

  const symlinkTarget = isSymlink
    ? await getSymlinkTarget(requestedPath, signal)
    : undefined;

  const stats = await withAbort(statAsync(resolvedPath), signal);

  return buildFileInfoResult(
    name,
    requestedPath,
    isSymlink,
    stats,
    mimeType,
    symlinkTarget
  );
}

type GetMultipleFileInfoOptions = FileInfoOptions;

function buildEmptyResult(): GetMultipleFileInfoResult {
  return {
    results: [],
    summary: { total: 0, succeeded: 0, failed: 0, totalSize: 0 },
  };
}

function buildIndexedPathTasks(
  paths: readonly string[]
): { filePath: string; index: number }[] {
  const tasks: { filePath: string; index: number }[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const filePath = paths[index];
    if (filePath !== undefined) {
      tasks.push({ filePath, index });
    }
  }
  return tasks;
}

async function readFileInfoInParallel(
  paths: readonly string[],
  options: GetMultipleFileInfoOptions
): Promise<{
  results: { index: number; value: MultipleFileInfoResult }[];
  errors: { index: number; error: Error }[];
}> {
  return processInParallel(
    buildIndexedPathTasks(paths),
    async ({ filePath, index }) => {
      const info = await getFileInfo(filePath, options);
      options.onProgress?.();
      return { index, value: { path: filePath, info } };
    },
    PARALLEL_CONCURRENCY,
    options.signal
  );
}

function calculateSummary(results: readonly MultipleFileInfoResult[]): {
  total: number;
  succeeded: number;
  failed: number;
  totalSize: number;
} {
  let succeeded = 0;
  let failed = 0;
  let totalSize = 0;

  for (const result of results) {
    if (result.info !== undefined) {
      succeeded++;
      totalSize += result.info.size;
    } else {
      failed++;
    }
  }

  return {
    total: results.length,
    succeeded,
    failed,
    totalSize,
  };
}

export async function getMultipleFileInfo(
  paths: readonly string[],
  options: GetMultipleFileInfoOptions = {}
): Promise<GetMultipleFileInfoResult> {
  if (paths.length === 0) return buildEmptyResult();

  const output: MultipleFileInfoResult[] = Array.from(paths, (p) => ({
    path: p,
  }));
  const { results, errors } = await readFileInfoInParallel(paths, options);

  applyIndexedValues(output, results);
  applyIndexedErrors({
    output,
    errors,
    resolveIndex: (failureIndex) =>
      failureIndex >= 0 && failureIndex < output.length
        ? failureIndex
        : undefined,
    buildValue: (resolvedIndex, error) => ({
      path: paths[resolvedIndex] ?? UNKNOWN_PATH,
      error,
    }),
  });

  return {
    results: output,
    summary: calculateSummary(output),
  };
}

interface ListDirectoryOptions {
  includeHidden?: boolean;
  excludePatterns?: readonly string[];
  maxDepth?: number;
  maxEntries?: number;
  sortBy?: 'name' | 'size' | 'modified' | 'type';
  includeSymlinkTargets?: boolean;
  pattern?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type ListDirectoryNormalizedOptions = Required<
  Omit<ListDirectoryOptions, 'signal' | 'pattern'>
> & {
  pattern?: string;
};

type StoppedReason = ListDirectoryResult['summary']['stoppedReason'];

interface EntryTotals {
  files: number;
  directories: number;
}

interface Counters {
  skippedInaccessible: number;
  symlinksNotFollowed: number;
}

interface EntryCandidate {
  path: string;
  dirent: DirentLike;
  stats?: Stats;
}

interface AppendContext {
  basePath: string;
  needsStats: boolean;
  includeSymlinkTargets: boolean;
  totals: EntryTotals;
  entries: DirectoryEntry[];
}

function normalizeListOptions(
  options: ListDirectoryOptions
): ListDirectoryNormalizedOptions {
  const normalized: ListDirectoryNormalizedOptions = {
    includeHidden: options.includeHidden ?? false,
    excludePatterns: options.excludePatterns ?? [],
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES,
    sortBy: options.sortBy ?? 'name',
    includeSymlinkTargets: options.includeSymlinkTargets ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
  };
  if (options.pattern && options.pattern.length > 0) {
    assertSafeGlobPattern(options.pattern);
    normalized.pattern = options.pattern;
  }
  return normalized;
}

const SORT_COMPARATORS: Record<
  NonNullable<ListDirectoryOptions['sortBy']>,
  (a: DirectoryEntry, b: DirectoryEntry) => number
> = {
  name: (a, b) => a.name.localeCompare(b.name),
  type: (a, b) => a.type.localeCompare(b.type),
  size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
  modified: (a, b) =>
    (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0),
};

function sortEntries(
  entries: DirectoryEntry[],
  sortBy: NonNullable<ListDirectoryOptions['sortBy']>
): void {
  entries.sort(SORT_COMPARATORS[sortBy]);
}

function resolveMaxDepth(normalized: ListDirectoryNormalizedOptions): number {
  return normalized.pattern ? normalized.maxDepth : 1;
}

async function* readDirectoryEntries(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  needsStats: boolean,
  signal: AbortSignal
): AsyncGenerator<EntryCandidate> {
  const dirents = await withAbort(
    readdirAsync(basePath, { withFileTypes: true }),
    signal
  );

  if (!needsStats) {
    for (const dirent of dirents) {
      if (!normalized.includeHidden && isHidden(dirent.name)) continue;
      yield { path: join(basePath, dirent.name), dirent };
    }
    return;
  }

  const filtered: { dirent: (typeof dirents)[number]; entryPath: string }[] =
    [];
  for (const dirent of dirents) {
    if (!normalized.includeHidden && isHidden(dirent.name)) continue;
    filtered.push({ dirent, entryPath: join(basePath, dirent.name) });
  }

  const { results, errors } = await processInParallel(
    filtered,
    async ({ entryPath, dirent }): Promise<EntryCandidate> => ({
      path: entryPath,
      dirent,
      stats: await withAbort(lstatAsync(entryPath), signal),
    }),
    PARALLEL_CONCURRENCY,
    signal
  );

  if (errors.length > 0) {
    throw errors[0]?.error ?? new Error('Failed to read entry stats');
  }

  yield* results;
}

function createEntryStream(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  maxDepth: number,
  needsStats: boolean,
  signal: AbortSignal
): AsyncIterable<EntryCandidate> {
  if (shouldUseFastPath(normalized, maxDepth)) {
    return readDirectoryEntries(basePath, normalized, needsStats, signal);
  }

  return globEntries({
    cwd: basePath,
    pattern: normalized.pattern ?? '*',
    excludePatterns: normalized.excludePatterns,
    includeHidden: normalized.includeHidden,
    baseNameMatch: false,
    caseSensitiveMatch: true,
    maxDepth,
    followSymbolicLinks: false,
    onlyFiles: false,
    stats: needsStats,
  });
}

function shouldUseFastPath(
  normalized: ListDirectoryNormalizedOptions,
  maxDepth: number
): boolean {
  return (
    !normalized.pattern &&
    normalized.excludePatterns.length === 0 &&
    maxDepth === 1
  );
}

function resolveRelativePath(basePath: string, entryPath: string): string {
  return relative(basePath, entryPath) || basename(entryPath);
}

async function resolveSymlinkTarget(
  entryType: EntryType,
  includeSymlinkTargets: boolean,
  entryPath: string
): Promise<string | undefined> {
  if (entryType !== 'symlink' || !includeSymlinkTargets) {
    return undefined;
  }
  return readlinkAsync(entryPath).catch(() => undefined);
}

function updateTotals(entryType: EntryType, totals: EntryTotals): void {
  if (entryType === 'file') totals.files += 1;
  if (entryType === 'directory') totals.directories += 1;
}

function buildDirectoryEntry(
  basePath: string,
  entry: { path: string; stats?: Stats },
  entryType: EntryType,
  needsStats: boolean,
  symlinkTarget: string | undefined
): DirectoryEntry {
  const size =
    needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;

  return {
    name: basename(entry.path),
    path: entry.path,
    relativePath: resolveRelativePath(basePath, entry.path),
    type: entryType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

function trackSymlink(
  entryType: EntryType,
  includeSymlinkTargets: boolean,
  counters: Counters
): void {
  if (entryType === 'symlink' && !includeSymlinkTargets) {
    counters.symlinksNotFollowed += 1;
  }
}

function appendEntry(
  entry: EntryCandidate,
  entryType: EntryType,
  symlinkTarget: string | undefined,
  ctx: AppendContext
): void {
  updateTotals(entryType, ctx.totals);

  ctx.entries.push(
    buildDirectoryEntry(
      ctx.basePath,
      entry,
      entryType,
      ctx.needsStats,
      symlinkTarget
    )
  );
}

async function enqueueAppendEntry(
  entry: EntryCandidate,
  entryType: EntryType,
  ctx: AppendContext,
  pending: Promise<void>[],
  flushPending: () => Promise<void>
): Promise<void> {
  if (!ctx.includeSymlinkTargets) {
    appendEntry(entry, entryType, undefined, ctx);
    return;
  }

  pending.push(
    resolveSymlinkTarget(entryType, true, entry.path).then((target) => {
      appendEntry(entry, entryType, target, ctx);
    })
  );

  if (pending.length >= PARALLEL_CONCURRENCY) {
    await flushPending();
  }
}

function buildSummary(
  entries: DirectoryEntry[],
  totals: EntryTotals,
  maxDepth: number,
  truncated: boolean,
  stoppedReason: StoppedReason | undefined,
  counters: Counters
): ListDirectoryResult['summary'] {
  const summary = {
    totalEntries: entries.length,
    entriesScanned: entries.length,
    entriesVisible: entries.length,
    totalFiles: totals.files,
    totalDirectories: totals.directories,
    maxDepthReached: maxDepth,
    truncated,
    skippedInaccessible: counters.skippedInaccessible,
    symlinksNotFollowed: counters.symlinksNotFollowed,
  };

  return withOptionalStoppedReason(summary, stoppedReason);
}

async function collectEntries(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  signal: AbortSignal,
  needsStats: boolean,
  maxDepth: number
): Promise<{
  entries: DirectoryEntry[];
  totals: EntryTotals;
  truncated: boolean;
  stoppedReason: StoppedReason | undefined;
  counters: Counters;
}> {
  const entries: DirectoryEntry[] = [];
  const totals: EntryTotals = { files: 0, directories: 0 };
  const counters: Counters = { skippedInaccessible: 0, symlinksNotFollowed: 0 };
  const basePathDirectories = [basePath];

  let truncated = false;
  let stoppedReason: StoppedReason | undefined;

  const pending: Promise<void>[] = [];
  let acceptedCount = 0;

  const stream = createEntryStream(
    basePath,
    normalized,
    maxDepth,
    needsStats,
    signal
  );

  const flushPending = async (): Promise<void> => {
    if (pending.length === 0) return;
    await Promise.allSettled(pending.splice(0));
  };

  const appendCtx: AppendContext = {
    basePath,
    needsStats,
    includeSymlinkTargets: normalized.includeSymlinkTargets,
    totals,
    entries,
  };

  for await (const entry of stream) {
    const stopReason = resolveStopReason<Exclude<StoppedReason, undefined>>({
      signal,
      current: acceptedCount,
      max: normalized.maxEntries,
      abortedReason: 'aborted',
      maxReason: 'maxEntries',
    });
    if (stopReason) {
      truncated = true;
      stoppedReason = stopReason;
      break;
    }

    const entryType = resolveEntryType(entry.dirent);
    trackSymlink(entryType, normalized.includeSymlinkTargets, counters);

    const accessible = await isEntryAccessibleByType(
      entry.path,
      entryType,
      basePathDirectories,
      signal,
      ACCESS_DEPS
    );
    if (!accessible) {
      counters.skippedInaccessible += 1;
      continue;
    }

    acceptedCount += 1;
    await enqueueAppendEntry(
      entry,
      entryType,
      appendCtx,
      pending,
      flushPending
    );
  }

  if (normalized.includeSymlinkTargets) {
    await flushPending();
  }

  return { entries, totals, truncated, stoppedReason, counters };
}

async function executeListDirectory(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  signal: AbortSignal
): Promise<{
  entries: DirectoryEntry[];
  summary: ListDirectoryResult['summary'];
}> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const maxDepth = resolveMaxDepth(normalized);

  const { entries, totals, truncated, stoppedReason, counters } =
    await collectEntries(basePath, normalized, signal, needsStats, maxDepth);

  sortEntries(entries, normalized.sortBy);

  return {
    entries,
    summary: buildSummary(
      entries,
      totals,
      maxDepth,
      truncated,
      stoppedReason,
      counters
    ),
  };
}

export async function listDirectory(
  dirPath: string,
  options: ListDirectoryOptions = {}
): Promise<ListDirectoryResult> {
  const normalized = normalizeListOptions(options);
  return withTimedAbortSignal(
    options.signal,
    normalized.timeoutMs,
    async (signal) => {
      const basePath = await validateExistingDirectory(dirPath, signal);
      const { entries, summary } = await executeListDirectory(
        basePath,
        normalized,
        signal
      );
      return { path: basePath, entries, summary };
    }
  );
}

interface TreeEntry {
  name: string;
  type: EntryType;
  relativePath: string;
  size?: number;
  children?: TreeEntry[];
}

interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
  includeSizes?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

interface TreeNormalizedOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  includeSizes: boolean;
  timeoutMs: number;
}

interface TreeResult {
  root: string;
  tree: TreeEntry;
  truncated: boolean;
  totalEntries: number;
}

function clampInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const asInt = Math.floor(value);
  return asInt >= min ? asInt : fallback;
}

function normalizeTreeOptions(options: TreeOptions): TreeNormalizedOptions {
  return {
    maxDepth: clampInt(options.maxDepth, 5, 0),
    maxEntries: clampInt(options.maxEntries, 1000, 0),
    includeHidden: options.includeHidden ?? false,
    includeIgnored: options.includeIgnored ?? false,
    includeSizes: options.includeSizes ?? false,
    timeoutMs: clampInt(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 1),
  };
}

function ensureParentNodes(
  rootNode: TreeEntry,
  nodeByPath: Map<string, TreeEntry>,
  relativePath: string
): TreeEntry {
  const normalized = toPosixPath(relativePath);
  if (normalized.length === 0 || normalized === '.') return rootNode;

  const segments = normalized.split('/').filter(Boolean);
  const parentSegmentCount = Math.max(0, segments.length - 1);
  let current = rootNode;
  let currentPath = '';

  for (let index = 0; index < parentSegmentCount; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    currentPath =
      currentPath.length === 0 ? segment : `${currentPath}/${segment}`;

    let child = nodeByPath.get(currentPath);
    if (!child) {
      child = {
        name: segment,
        type: 'directory',
        relativePath: currentPath,
        children: [],
      };
      nodeByPath.set(currentPath, child);
      current.children ??= [];
      current.children.push(child);
    }

    current = child;
  }

  return current;
}

function sortTree(node: TreeEntry): void {
  if (!node.children) return;
  node.children.sort(compareTreeEntries);
  for (const child of node.children) {
    sortTree(child);
  }
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const diff = getTreeTypeRank(a.type) - getTreeTypeRank(b.type);
  if (diff !== 0) return diff;
  return a.name.localeCompare(b.name);
}

const TREE_TYPE_RANKS: Record<string, number> = { directory: 0, file: 1 };

function getTreeTypeRank(type: EntryType): number {
  return TREE_TYPE_RANKS[type] ?? 2;
}

async function resolveTreeEntry(
  entry: {
    path: string;
    dirent: DirentLike;
  },
  root: string,
  rootDirectories: readonly string[],
  gitignoreMatcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  signal: AbortSignal,
  accessDeps: EntryAccessDependencies
): Promise<{
  type: EntryType;
  relativePosix: string;
  name: string;
} | null> {
  const type = resolveEntryType(entry.dirent);
  const isAccessible = await isEntryAccessibleByType(
    entry.path,
    type,
    rootDirectories,
    signal,
    accessDeps
  );
  if (!isAccessible) {
    return null;
  }

  if (
    gitignoreMatcher &&
    isIgnoredByGitignore(gitignoreMatcher, root, entry.path, {
      isDirectory: type === 'directory',
    })
  ) {
    return null;
  }

  const relativePosix = toPosixPath(resolveRelativePath(root, entry.path));
  const name = basename(entry.path);
  return { type, relativePosix, name };
}

function upsertChildNode(
  parent: TreeEntry,
  nodeByPath: Map<string, TreeEntry>,
  resolved: { type: EntryType; relativePosix: string; name: string },
  childPathIndexByParent: WeakMap<TreeEntry, Set<string>>
): void {
  const ensureDirectoryShape = (node: TreeEntry): void => {
    if (node.type === 'directory') {
      node.children ??= [];
    } else {
      delete node.children;
    }
  };

  const maybeUpdateType = (existing: TreeEntry, nextType: EntryType): void => {
    if (existing.type === nextType) return;

    const preservePopulatedDirectory =
      existing.type === 'directory' &&
      Array.isArray(existing.children) &&
      existing.children.length > 0;
    if (preservePopulatedDirectory) return;

    existing.type = nextType;
    ensureDirectoryShape(existing);
  };

  const attachChild = (child: TreeEntry): void => {
    parent.children ??= [];
    let seen = childPathIndexByParent.get(parent);
    if (!seen) {
      seen = new Set<string>();
      for (const entry of parent.children) {
        seen.add(entry.relativePath);
      }
      childPathIndexByParent.set(parent, seen);
    }
    const key = child.relativePath;
    if (seen.has(key)) return;
    seen.add(key);
    parent.children.push(child);
  };

  const existing = nodeByPath.get(resolved.relativePosix);
  if (existing) {
    // Avoid duplicate directory nodes when a child file is encountered before the directory entry.
    // Prefer preserving an existing populated directory node over overwriting it.
    maybeUpdateType(existing, resolved.type);
    existing.name = resolved.name;
    existing.relativePath = resolved.relativePosix;

    ensureDirectoryShape(existing);
    attachChild(existing);
    return;
  }

  const node: TreeEntry = {
    name: resolved.name,
    type: resolved.type,
    relativePath: resolved.relativePosix,
    ...(resolved.type === 'directory' ? { children: [] as TreeEntry[] } : {}),
  };

  nodeByPath.set(resolved.relativePosix, node);
  attachChild(node);
}

export function formatTreeAscii(tree: TreeEntry): string {
  const lines: string[] = [];

  const walk = (
    node: TreeEntry,
    prefix: string,
    isLast: boolean,
    isRoot: boolean
  ): void => {
    let connector = '';
    let linePrefix = '';
    if (!isRoot) {
      connector = isLast ? '└── ' : '├── ';
      linePrefix = prefix;
    }
    lines.push(`${linePrefix}${connector}${node.name}`);

    if (!node.children || node.children.length === 0) return;

    let nextPrefix = '';
    if (!isRoot) {
      const continuation = isLast ? '    ' : '│   ';
      nextPrefix = `${prefix}${continuation}`;
    }

    const count = node.children.length;
    for (let index = 0; index < count; index += 1) {
      const child = node.children[index];
      if (child) {
        walk(child, nextPrefix, index === count - 1, false);
      }
    }
  };

  walk(tree, '', true, true);
  return lines.join('\n');
}

export async function treeDirectory(
  dirPath: string,
  options: TreeOptions = {}
): Promise<TreeResult> {
  const normalized = normalizeTreeOptions(options);
  return withTimedAbortSignal(
    options.signal,
    normalized.timeoutMs,
    async (signal) => {
      const root = await validateExistingDirectory(dirPath, signal);
      const rootNormalized = normalizePath(root);
      const rootDirectories = [rootNormalized];

      const excludePatterns = normalized.includeIgnored
        ? []
        : DEFAULT_EXCLUDE_PATTERNS;

      const gitignoreMatcher = normalized.includeIgnored
        ? null
        : await loadRootGitignore(root, signal);

      const rootNode: TreeEntry = {
        name: basename(root) || root,
        type: 'directory',
        relativePath: '.',
        children: [],
      };

      const nodeByPath = new Map<string, TreeEntry>();
      const childPathIndexByParent = new WeakMap<TreeEntry, Set<string>>();
      let totalEntries = 0;
      let truncated = false;

      const stream = globEntries({
        cwd: root,
        pattern: '**/*',
        excludePatterns,
        includeHidden: normalized.includeHidden,
        baseNameMatch: false,
        caseSensitiveMatch: true,
        maxDepth: normalized.maxDepth,
        followSymbolicLinks: false,
        onlyFiles: false,
        stats: normalized.includeSizes,
        suppressErrors: true,
      });

      for await (const entry of stream) {
        const stopReason = resolveStopReason<'aborted' | 'maxEntries'>({
          signal,
          current: totalEntries,
          max: normalized.maxEntries,
          abortedReason: 'aborted',
          maxReason: 'maxEntries',
        });
        if (stopReason) {
          truncated = true;
          break;
        }

        const resolved = await resolveTreeEntry(
          entry,
          root,
          rootDirectories,
          gitignoreMatcher,
          signal,
          ACCESS_DEPS
        );
        if (!resolved) {
          continue;
        }

        const parent = ensureParentNodes(
          rootNode,
          nodeByPath,
          resolved.relativePosix
        );

        upsertChildNode(parent, nodeByPath, resolved, childPathIndexByParent);

        if (
          normalized.includeSizes &&
          resolved.type === 'file' &&
          entry.stats
        ) {
          const node = nodeByPath.get(resolved.relativePosix);
          if (node) {
            node.size = entry.stats.size;
          }
        }

        totalEntries += 1;
        options.onProgress?.({ current: totalEntries });
      }

      sortTree(rootNode);

      return {
        root,
        tree: rootNode,
        truncated,
        totalEntries,
      };
    }
  );
}

interface ReadMultipleResult {
  path: string;
  content?: string;
  truncated?: boolean;
  totalLines?: number;
  readMode?: 'full' | 'head' | 'tail' | 'range';
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  error?: Error;
}

interface NormalizedReadMultipleOptions {
  encoding: BufferEncoding;
  maxSize: number;
  maxTotalSize: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
}

interface ReadMultipleOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  maxTotalSize?: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  signal?: AbortSignal;
  onReadComplete?: () => void;
}

interface FileReadTask {
  filePath: string;
  index: number;
  validPath?: string;
  stats?: Stats;
}

interface LineSelectionOptions {
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
}

function estimateReadSize(stats: Stats, maxSize: number): number {
  // `readFile`/`readFileWithStats` are always invoked with a `maxSize` cap, so the
  // combined budget should reflect the maximum number of bytes we might actually read.
  return Math.min(stats.size, maxSize);
}

type ReadFileOptions = LineSelectionOptions & {
  encoding: BufferEncoding;
  maxSize: number;
  skipBinary?: boolean;
};

function buildReadOptions(
  options: NormalizedReadMultipleOptions
): ReadFileOptions {
  const readOptions: ReadFileOptions = {
    encoding: options.encoding,
    maxSize: options.maxSize,
    skipBinary: true,
  };
  applyLineSelection(readOptions, options);
  return readOptions;
}

function buildReadMultipleResult(
  filePath: string,
  result: Awaited<ReturnType<typeof readFile>>
): ReadMultipleResult {
  const output: ReadMultipleResult = {
    path: filePath,
    content: result.content,
    truncated: result.truncated,
    readMode: result.readMode,
  };
  if (result.totalLines !== undefined) output.totalLines = result.totalLines;
  if (result.head !== undefined) output.head = result.head;
  if (result.tail !== undefined) output.tail = result.tail;
  if (result.startLine !== undefined) output.startLine = result.startLine;
  if (result.endLine !== undefined) output.endLine = result.endLine;
  if (result.linesRead !== undefined) output.linesRead = result.linesRead;
  if (result.hasMoreLines !== undefined) {
    output.hasMoreLines = result.hasMoreLines;
  }
  return output;
}

async function readSingleFile(
  task: FileReadTask,
  readOptions: Parameters<typeof readFile>[1]
): Promise<{ index: number; value: ReadMultipleResult }> {
  const { filePath, index, validPath, stats } = task;
  const result =
    validPath && stats
      ? await readFileWithStats(filePath, validPath, stats, readOptions)
      : await readFile(filePath, readOptions);

  return {
    index,
    value: buildReadMultipleResult(filePath, result),
  };
}

async function readFilesInParallel(
  filesToProcess: FileReadTask[],
  options: NormalizedReadMultipleOptions,
  signal?: AbortSignal,
  onReadComplete?: () => void
): Promise<{
  results: { index: number; value: ReadMultipleResult }[];
  errors: { index: number; error: Error }[];
}> {
  const readOptions: Parameters<typeof readFile>[1] = buildReadOptions(options);
  if (signal) {
    readOptions.signal = signal;
  }
  return processInParallel(
    filesToProcess,
    async (task) => {
      const result = await readSingleFile(task, readOptions);
      onReadComplete?.();
      return result;
    },
    PARALLEL_CONCURRENCY,
    signal
  );
}

function normalizeReadMultipleOptions(
  options: ReadMultipleOptions
): NormalizedReadMultipleOptions {
  const normalized: NormalizedReadMultipleOptions = {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    maxTotalSize: options.maxTotalSize ?? DEFAULT_READ_MANY_MAX_TOTAL_SIZE,
  };
  applyLineSelection(normalized, options);
  return normalized;
}

function applyLineSelection(
  target: LineSelectionOptions,
  source: LineSelectionOptions
): void {
  if (source.head !== undefined) target.head = source.head;
  if (source.tail !== undefined) target.tail = source.tail;
  if (source.endLine !== undefined) {
    target.startLine = source.startLine ?? 1;
    target.endLine = source.endLine;
  } else if (source.startLine !== undefined) {
    target.startLine = source.startLine;
  }
}

function resolveNormalizedReadOptions(options: ReadMultipleOptions): {
  normalized: NormalizedReadMultipleOptions;
  signal?: AbortSignal;
} {
  const { signal, ...rest } = options;
  const result: {
    normalized: NormalizedReadMultipleOptions;
    signal?: AbortSignal;
  } = {
    normalized: normalizeReadMultipleOptions(rest),
  };
  if (signal) result.signal = signal;
  return result;
}

interface ValidatedFileInfo {
  index: number;
  filePath: string;
  validPath: string;
  stats: Stats;
}

async function validateFile(
  filePath: string,
  index: number,
  signal?: AbortSignal
): Promise<ValidatedFileInfo> {
  const validPath = await validateExistingPath(filePath, signal);
  const stats = await withAbort(statAsync(validPath), signal);
  return { filePath, index, validPath, stats };
}

function markRemainingSkipped(
  startIndex: number,
  total: number,
  skippedBudget: Set<number>
): void {
  for (let index = startIndex; index < total; index += 1) {
    skippedBudget.add(index);
  }
}

async function tryValidateFile(
  filePath: string,
  index: number,
  signal?: AbortSignal
): Promise<ValidatedFileInfo | undefined> {
  try {
    return await validateFile(filePath, index, signal);
  } catch {
    return undefined;
  }
}

async function validateBatch(
  tasks: { filePath: string; index: number }[],
  signal?: AbortSignal
): Promise<Map<number, ValidatedFileInfo>> {
  if (tasks.length === 0) return new Map<number, ValidatedFileInfo>();

  const { results } = await processInParallel(
    tasks,
    async (task) => tryValidateFile(task.filePath, task.index, signal),
    PARALLEL_CONCURRENCY,
    signal
  );

  const infos = new Map<number, ValidatedFileInfo>();
  for (const info of results) {
    if (!info) continue;
    infos.set(info.index, info);
  }
  return infos;
}

function applyBudgetForRange(options: {
  batchStart: number;
  batchEnd: number;
  totalFiles: number;
  maxTotalSize: number;
  maxSize: number;
  validated: Map<number, ValidatedFileInfo>;
  skippedBudget: Set<number>;
  totalSize: number;
}): { totalSize: number; exceeded: boolean } {
  const {
    batchStart,
    batchEnd,
    totalFiles,
    maxTotalSize,
    maxSize,
    validated,
    skippedBudget,
    totalSize: startingTotalSize,
  } = options;
  let totalSize = startingTotalSize;

  for (let index = batchStart; index < batchEnd; index += 1) {
    const info = validated.get(index);
    if (!info) continue;

    const { exceeded, totalSize: nextTotalSize } = applyBudget(
      totalSize,
      estimateReadSize(info.stats, maxSize),
      maxTotalSize,
      index,
      totalFiles,
      skippedBudget
    );
    if (exceeded) {
      return { totalSize, exceeded: true };
    }
    totalSize = nextTotalSize;
  }

  return { totalSize, exceeded: false };
}

async function collectFileBudget(
  filePaths: readonly string[],
  maxTotalSize: number,
  maxSize: number,
  signal?: AbortSignal
): Promise<{
  skippedBudget: Set<number>;
  validated: Map<number, ValidatedFileInfo>;
}> {
  const skippedBudget = new Set<number>();
  const validated = new Map<number, ValidatedFileInfo>();
  let totalSize = 0;
  const totalFiles = filePaths.length;

  for (
    let batchStart = 0;
    batchStart < totalFiles;
    batchStart += PARALLEL_CONCURRENCY
  ) {
    const batchTasks: { filePath: string; index: number }[] = [];
    const batchEnd = Math.min(batchStart + PARALLEL_CONCURRENCY, totalFiles);

    for (let index = batchStart; index < batchEnd; index += 1) {
      const filePath = filePaths[index];
      if (!filePath) continue;
      if (validated.has(index)) continue;
      batchTasks.push({ filePath, index });
    }

    const batchInfos = await validateBatch(batchTasks, signal);
    for (const [index, info] of batchInfos) {
      validated.set(index, info);
    }

    const budgetResult = applyBudgetForRange({
      batchStart,
      batchEnd,
      totalFiles,
      maxTotalSize,
      maxSize,
      validated,
      skippedBudget,
      totalSize,
    });

    const { exceeded, totalSize: nextTotalSize } = budgetResult;
    if (exceeded) {
      return { skippedBudget, validated };
    }
    totalSize = nextTotalSize;
  }

  return { skippedBudget, validated };
}

function buildOutput(filePaths: readonly string[]): ReadMultipleResult[] {
  return Array.from(filePaths, (fp) => ({ path: fp }));
}

function resolveErrorOriginalIndex(
  failureIndex: number,
  filesToProcess: { index: number }[],
  totalInputFiles: number
): number | undefined {
  // processInParallel implementations vary: some return error indices relative to
  // the submitted batch (filesToProcess), others may forward the task/index.
  const batchIndex = filesToProcess[failureIndex]?.index;
  if (
    typeof batchIndex === 'number' &&
    batchIndex >= 0 &&
    batchIndex < totalInputFiles
  ) {
    return batchIndex;
  }
  if (failureIndex >= 0 && failureIndex < totalInputFiles) {
    return failureIndex;
  }
  return undefined;
}

function buildFilesToProcess(
  filePaths: readonly string[],
  validated: Map<
    number,
    {
      validPath: string;
      stats: Stats;
    }
  >,
  skippedBudget: Set<number>
): FileReadTask[] {
  const filesToProcess: FileReadTask[] = [];
  for (let index = 0; index < filePaths.length; index += 1) {
    if (skippedBudget.has(index)) continue;
    const filePath = filePaths[index];
    if (!filePath) continue;
    const cached = validated.get(index);
    if (cached) {
      filesToProcess.push({
        filePath,
        index,
        validPath: cached.validPath,
        stats: cached.stats,
      });
      continue;
    }
    filesToProcess.push({ filePath, index });
  }
  return filesToProcess;
}

function applyBudget(
  totalSize: number,
  estimatedSize: number,
  maxTotalSize: number,
  index: number,
  totalFiles: number,
  skippedBudget: Set<number>
): { totalSize: number; exceeded: boolean } {
  if (totalSize + estimatedSize > maxTotalSize) {
    skippedBudget.add(index);
    markRemainingSkipped(index + 1, totalFiles, skippedBudget);
    return { totalSize, exceeded: true };
  }
  return { totalSize: totalSize + estimatedSize, exceeded: false };
}

function applySkippedBudget(
  output: ReadMultipleResult[],
  skippedBudget: Set<number>,
  filePaths: readonly string[],
  maxTotalSize: number
): void {
  for (const index of skippedBudget) {
    const filePath = filePaths[index];
    if (!filePath) continue;
    output[index] = {
      path: filePath,
      error: new Error(
        `Skipped: combined estimated read would exceed maxTotalSize (${maxTotalSize} bytes)`
      ),
    };
  }
}

export async function readMultipleFiles(
  filePaths: readonly string[],
  options: ReadMultipleOptions = {}
): Promise<ReadMultipleResult[]> {
  if (filePaths.length === 0) return [];

  const { normalized, signal } = resolveNormalizedReadOptions(options);

  const output = buildOutput(filePaths);
  const { skippedBudget, validated } = await collectFileBudget(
    filePaths,
    normalized.maxTotalSize,
    normalized.maxSize,
    signal
  );

  const filesToProcess = buildFilesToProcess(
    filePaths,
    validated,
    skippedBudget
  );

  const { results, errors } = await readFilesInParallel(
    filesToProcess,
    normalized,
    signal,
    options.onReadComplete
  );

  applyIndexedValues(output, results);
  applyIndexedErrors({
    output,
    errors,
    resolveIndex: (failureIndex) =>
      resolveErrorOriginalIndex(failureIndex, filesToProcess, filePaths.length),
    buildValue: (resolvedIndex, error) => ({
      path: filePaths[resolvedIndex] ?? UNKNOWN_PATH,
      error,
    }),
  });
  applySkippedBudget(output, skippedBudget, filePaths, normalized.maxTotalSize);

  return output;
}
