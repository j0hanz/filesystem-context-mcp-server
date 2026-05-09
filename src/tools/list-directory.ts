import { randomUUID } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import { z } from 'zod/v4';

import { withAbort, withTimedAbortSignal } from '../core/abort.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_LIST_MAX_ENTRIES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
  PARALLEL_CONCURRENCY,
} from '../core/constants.js';
import { ErrorCode, McpError } from '../core/errors.js';
import {
  type DirentLike,
  type EntryAccessDependencies,
  type EntryType,
  globEntries,
  isEntryAccessibleByType,
  isHidden,
  needsStatsForSort,
  resolveEntryType,
  resolveStopReason,
  withOptionalStoppedReason,
} from '../core/fs-walk.js';
import { processInParallel } from '../core/parallel.js';
import { isPathWithinDirectories, normalizePath } from '../core/path-guard.js';
import type { PathGuard } from '../core/path-guard.js';
import { createBase64JsonCodec } from '../core/zod-codecs.js';
import {
  FileType as FileTypeEnum,
  NonNegInt,
  OptionalPath,
  SafeGlobPattern,
} from '../schemas/fields.js';
import {
  CursorSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
  NextCursorSchema,
} from '../schemas/shared.js';

import type { DirectoryEntry, ListDirectoryResult } from '../config.js';
import { formatOperationSummary, joinLines } from '../config.js';
import { defineTool } from './define-tool.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildResourceResponse,
  buildToolResponse,
  putResource,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
  type ToolResponse,
  type ToolResult,
} from './shared.js';

// ---------------------------------------------------------------------------
// Private listDirectory implementation (inlined from lib/file-operations/metadata.ts)
// ---------------------------------------------------------------------------

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

type ListDirectoryNormalizedOptions = Required<Omit<ListDirectoryOptions, 'signal' | 'pattern'>> & {
  pattern?: string;
};

type ListStoppedReason = ListDirectoryResult['summary']['stoppedReason'];

interface EntryTotals {
  files: number;
  directories: number;
}

interface ListCounters {
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
  options: ListDirectoryOptions,
  pathGuard: PathGuard,
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
    pathGuard.assertSafeGlob(options.pattern);
    normalized.pattern = options.pattern;
  }
  return normalized;
}

const LIST_SORT_COMPARATORS: Record<
  NonNullable<ListDirectoryOptions['sortBy']>,
  (a: DirectoryEntry, b: DirectoryEntry) => number
> = {
  name: (a, b) => a.name.localeCompare(b.name),
  type: (a, b) => a.type.localeCompare(b.type),
  size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
  modified: (a, b) => (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0),
};

function sortListEntries(
  entries: DirectoryEntry[],
  sortBy: NonNullable<ListDirectoryOptions['sortBy']>,
): void {
  entries.sort(LIST_SORT_COMPARATORS[sortBy]);
}

function resolveListMaxDepth(normalized: ListDirectoryNormalizedOptions): number {
  return normalized.pattern ? normalized.maxDepth : 1;
}

function filterDirents(
  dirents: Dirent[],
  basePath: string,
  includeHidden: boolean,
): { dirent: Dirent; entryPath: string }[] {
  const filtered: { dirent: Dirent; entryPath: string }[] = [];
  for (const dirent of dirents) {
    if (!includeHidden && isHidden(dirent.name)) continue;
    filtered.push({ dirent, entryPath: join(basePath, dirent.name) });
  }
  return filtered;
}

async function* readDirectoryEntries(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  needsStats: boolean,
  signal: AbortSignal,
): AsyncGenerator<EntryCandidate> {
  const dirents = await withAbort(readdir(basePath, { withFileTypes: true }), signal);
  const filtered = filterDirents(dirents, basePath, normalized.includeHidden);

  if (!needsStats) {
    for (const { dirent, entryPath } of filtered) {
      yield { path: entryPath, dirent };
    }
    return;
  }

  const { results, errors } = await processInParallel(
    filtered,
    async ({ entryPath, dirent }): Promise<EntryCandidate> => ({
      path: entryPath,
      dirent,
      stats: await withAbort(lstat(entryPath), signal),
    }),
    PARALLEL_CONCURRENCY,
    signal,
  );

  if (errors.length > 0) {
    throw errors[0]?.error ?? new Error('Failed to read entry stats');
  }

  yield* results;
}

function shouldUseFastPath(normalized: ListDirectoryNormalizedOptions, maxDepth: number): boolean {
  return !normalized.pattern && normalized.excludePatterns.length === 0 && maxDepth === 1;
}

function createListEntryStream(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  maxDepth: number,
  needsStats: boolean,
  signal: AbortSignal,
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

function resolveListRelativePath(basePath: string, entryPath: string): string {
  return relative(basePath, entryPath) || basename(entryPath);
}

async function resolveSymlinkTarget(
  entryType: EntryType,
  entryPath: string,
): Promise<string | undefined> {
  if (entryType !== 'symlink') return undefined;
  return readlink(entryPath).catch(() => undefined);
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
  symlinkTarget: string | undefined,
): DirectoryEntry {
  const size = needsStats && entry.stats?.isFile() ? entry.stats.size : undefined;
  const modified = needsStats ? entry.stats?.mtime : undefined;
  return {
    name: basename(entry.path),
    path: entry.path,
    relativePath: resolveListRelativePath(basePath, entry.path),
    type: entryType,
    ...(size !== undefined ? { size } : {}),
    ...(modified !== undefined ? { modified } : {}),
    ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
  };
}

function trackSymlink(
  entryType: EntryType,
  includeSymlinkTargets: boolean,
  counters: ListCounters,
): void {
  if (entryType === 'symlink' && !includeSymlinkTargets) {
    counters.symlinksNotFollowed += 1;
  }
}

function appendEntry(
  entry: EntryCandidate,
  entryType: EntryType,
  symlinkTarget: string | undefined,
  ctx: AppendContext,
): void {
  updateTotals(entryType, ctx.totals);
  ctx.entries.push(
    buildDirectoryEntry(ctx.basePath, entry, entryType, ctx.needsStats, symlinkTarget),
  );
}

async function enqueueAppendEntry(
  entry: EntryCandidate,
  entryType: EntryType,
  ctx: AppendContext,
  pending: Promise<void>[],
  flushPending: () => Promise<void>,
): Promise<void> {
  if (!ctx.includeSymlinkTargets) {
    appendEntry(entry, entryType, undefined, ctx);
    return;
  }
  pending.push(
    resolveSymlinkTarget(entryType, entry.path).then((target) => {
      appendEntry(entry, entryType, target, ctx);
    }),
  );
  if (pending.length >= PARALLEL_CONCURRENCY) {
    await flushPending();
  }
}

function buildListSummary(
  entries: DirectoryEntry[],
  totals: EntryTotals,
  maxDepth: number,
  truncated: boolean,
  stoppedReason: ListStoppedReason | undefined,
  counters: ListCounters,
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

async function collectListEntries(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  signal: AbortSignal,
  needsStats: boolean,
  maxDepth: number,
  deps: EntryAccessDependencies,
): Promise<{
  entries: DirectoryEntry[];
  totals: EntryTotals;
  truncated: boolean;
  stoppedReason: ListStoppedReason | undefined;
  counters: ListCounters;
}> {
  const entries: DirectoryEntry[] = [];
  const totals: EntryTotals = { files: 0, directories: 0 };
  const counters: ListCounters = {
    skippedInaccessible: 0,
    symlinksNotFollowed: 0,
  };
  const basePathDirectories = [basePath];
  let truncated = false;
  let stoppedReason: ListStoppedReason | undefined;
  const pending: Promise<void>[] = [];
  let acceptedCount = 0;

  const stream = createListEntryStream(basePath, normalized, maxDepth, needsStats, signal);

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
    const stopReason = resolveStopReason<Exclude<ListStoppedReason, undefined>>({
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
      deps,
    );
    if (!accessible) {
      counters.skippedInaccessible += 1;
      continue;
    }

    acceptedCount += 1;
    await enqueueAppendEntry(entry, entryType, appendCtx, pending, flushPending);
  }

  if (normalized.includeSymlinkTargets) {
    await flushPending();
  }

  return { entries, totals, truncated, stoppedReason, counters };
}

async function executeListDirectory(
  basePath: string,
  normalized: ListDirectoryNormalizedOptions,
  signal: AbortSignal,
  deps: EntryAccessDependencies,
): Promise<{
  entries: DirectoryEntry[];
  summary: ListDirectoryResult['summary'];
}> {
  const needsStats = needsStatsForSort(normalized.sortBy);
  const maxDepth = resolveListMaxDepth(normalized);
  const { entries, totals, truncated, stoppedReason, counters } = await collectListEntries(
    basePath,
    normalized,
    signal,
    needsStats,
    maxDepth,
    deps,
  );
  sortListEntries(entries, normalized.sortBy);
  return {
    entries,
    summary: buildListSummary(entries, totals, maxDepth, truncated, stoppedReason, counters),
  };
}

async function listDirectory(
  dirPath: string,
  pathGuard: PathGuard,
  options: ListDirectoryOptions = {},
): Promise<ListDirectoryResult> {
  const normalized = normalizeListOptions(options, pathGuard);
  const deps: EntryAccessDependencies = {
    normalizePath,
    isPathWithinDirectories,
    isSensitivePath: (p) => pathGuard.isSensitive(p),
    validateSymlinkPath: (p) => pathGuard.validateExistingPathDetailed(p),
  };
  return withTimedAbortSignal(options.signal, normalized.timeoutMs, async (signal) => {
    const basePath = await pathGuard.validateExistingDirectory(dirPath);
    const { entries, summary } = await executeListDirectory(basePath, normalized, signal, deps);
    return { path: basePath, entries, summary };
  });
}

// ---------------------------------------------------------------------------

const ListDirectoryInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  maxDepth: z
    .uint32()
    .min(1)
    .max(MAX_TREE_DEPTH)
    .optional()
    .describe('Max directory depth (default: flat listing)'),
  maxEntries: z
    .uint32()
    .min(1)
    .max(MAX_LIST_ENTRIES)
    .optional()
    .default(DEFAULT_LIST_MAX_ENTRIES)
    .describe('Max entries to return per page'),
  sortBy: z
    .enum(['name', 'size', 'modified', 'type'])
    .optional()
    .default('name')
    .describe('Sort order'),
  pattern: SafeGlobPattern.optional(),
  includeSymlinkTargets: defaultFalseBoolean('Resolve symlink targets'),
  cursor: CursorSchema,
});

const ListDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Listed directory path'),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z.string().describe('Relative path from listed directory'),
        type: FileTypeEnum.describe('Entry type'),
        size: NonNegInt.optional().describe('Size in bytes'),
        modified: z.string().optional().describe('ISO 8601 last modified time'),
      }),
    )
    .describe('Directory entries'),
  entryCount: NonNegInt.optional().describe('Total number of entries'),
  resourceUri: z.string().optional().describe('Resource URI for full JSON listing'),
  totalEntries: NonNegInt.optional().describe('Total entries scanned'),
  totalFiles: NonNegInt.optional().describe('Total files'),
  totalDirectories: NonNegInt.optional().describe('Total directories'),
  stoppedReason: z.string().optional().describe('Why enumeration stopped'),
  skippedInaccessible: NonNegInt.optional().describe('Inaccessible entries skipped'),
  nextCursor: NextCursorSchema,
});

const LIST_DIRECTORY_TOOL: ToolContract = {
  name: 'ls',
  title: 'List Directory',
  description:
    'List directory contents with optional bounded recursion via `maxDepth`. ' +
    'Returns name, path, type, size, modified date. ' +
    'Omit path for workspace root. `includeIgnored=true` for node_modules etc. ' +
    'For glob-based recursive search, use `find`.',
  inputSchema: ListDirectoryInputSchema,
  outputSchema: ListDirectoryOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  taskSupport: 'optional',
  nuances: ['`pattern` enables filtered recursive traversal up to `maxDepth`.'],
} as const;

interface ListSnapshot {
  entries: Awaited<ReturnType<typeof listDirectory>>['entries'];
  summary: Awaited<ReturnType<typeof listDirectory>>['summary'];
  path: string;
  fingerprint: string;
}

const LIST_CURSOR_TTL_MS =
  parseInt(process.env.FS_CONTEXT_LIST_CURSOR_TTL_MS ?? '', 10) || 5 * 60 * 1000;
const listSnapshots = new Map<string, ListSnapshot>();
const listSnapshotTimers = new Map<string, NodeJS.Timeout>();
const ListCursorPayloadSchema = z.strictObject({
  snapshotId: z.string().min(1),
  offset: z.int().min(0),
});
const ListCursorCodec = createBase64JsonCodec(ListCursorPayloadSchema);

type ListCursorPayload = z.infer<typeof ListCursorPayloadSchema>;

function buildListFingerprint(
  args: z.infer<typeof ListDirectoryInputSchema>,
  pathGuard: PathGuard,
): string {
  return JSON.stringify({
    path: pathGuard.resolvePathOrRoot(args.path),
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    maxDepth: args.maxDepth,
    sortBy: args.sortBy,
    pattern: args.pattern,
    includeSymlinkTargets: args.includeSymlinkTargets,
  });
}

function deleteListSnapshot(snapshotId: string): void {
  listSnapshots.delete(snapshotId);
  const timer = listSnapshotTimers.get(snapshotId);
  if (timer) {
    clearTimeout(timer);
    listSnapshotTimers.delete(snapshotId);
  }
}

function storeListSnapshot(snapshot: ListSnapshot): string {
  const snapshotId = randomUUID();
  listSnapshots.set(snapshotId, snapshot);
  const timer = setTimeout(() => {
    deleteListSnapshot(snapshotId);
  }, LIST_CURSOR_TTL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  listSnapshotTimers.set(snapshotId, timer);
  return snapshotId;
}

function encodeListCursor(payload: ListCursorPayload): string {
  return z.encode(ListCursorCodec, payload);
}

function decodeListCursor(cursor: string): ListCursorPayload {
  try {
    return ListCursorCodec.parse(cursor);
  } catch {
    // fall through to throw
  }

  throw new McpError(ErrorCode.INVALID_INPUT, 'Invalid or expired cursor.');
}

function resolveNextListCursor(
  snapshotId: string | undefined,
  offset: number,
  pageSize: number,
  totalEntries: number,
): string | undefined {
  if (!snapshotId) return undefined;
  const nextOffset = offset + pageSize;
  if (nextOffset >= totalEntries) {
    deleteListSnapshot(snapshotId);
    return undefined;
  }
  return encodeListCursor({ snapshotId, offset: nextOffset });
}

function buildEntrySummaryPart(entries: readonly DirectoryEntry[]): string {
  const files = entries.filter((e) => e.type === 'file').length;
  const directories = entries.filter((e) => e.type === 'directory').length;
  const symlinks = entries.filter((e) => e.type === 'symlink').length;

  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (directories > 0) parts.push(`${directories} dir${directories === 1 ? '' : 's'}`);
  if (symlinks > 0) parts.push(`${symlinks} symlink${symlinks === 1 ? '' : 's'}`);

  if (parts.length === 0) return '';
  return ` (${parts.join(', ')})`;
}

function buildListSummaryText(dirPath: string, entryCount: number): string {
  return `list-directory: ${dirPath} · ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`;
}

function buildListTextResult(
  result: Awaited<ReturnType<typeof listDirectory>>,
  nextCursor?: string,
): string {
  const { entries, summary, path } = result;
  if (entries.length === 0) {
    if (!summary.entriesScanned || summary.entriesScanned === 0) {
      return `${path} (empty)`;
    }
    return `${path} (no matches)`;
  }

  const lines = [path];
  for (const entry of entries) {
    const suffix = entry.type === 'directory' ? '/' : '';
    lines.push(`  ${entry.relativePath}${suffix}`);
  }

  let truncatedReason: string | undefined;
  if (summary.truncated) {
    if (summary.stoppedReason === 'maxEntries') {
      truncatedReason = `max entries (${summary.totalEntries})`;
    } else {
      truncatedReason = 'aborted';
    }
  }

  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  };

  let text = joinLines(lines) + formatOperationSummary(summaryOptions);
  if (nextCursor) {
    text += `\n[Next page available. Use cursor: "${nextCursor}"]`;
  }
  return text;
}

function buildStructuredListEntry(
  entry: Awaited<ReturnType<typeof listDirectory>>['entries'][number],
): NonNullable<z.infer<typeof ListDirectoryOutputSchema>['entries']>[number] {
  return {
    name: entry.name,
    relativePath: entry.relativePath,
    type: entry.type,
    size: entry.size,
    modified: entry.modified?.toISOString(),
  };
}

function buildStructuredListResult(
  result: Awaited<ReturnType<typeof listDirectory>>,
  nextCursor?: string,
  resourceUri?: string,
  entryCount?: number,
): z.infer<typeof ListDirectoryOutputSchema> {
  const { entries, summary, path: resultPath } = result;
  const structuredEntries: NonNullable<z.infer<typeof ListDirectoryOutputSchema>['entries']> = [];
  for (const entry of entries) {
    structuredEntries.push(buildStructuredListEntry(entry));
  }
  return {
    ok: true,
    path: resultPath,
    entries: structuredEntries,
    ...(resourceUri !== undefined ? { resourceUri } : {}),
    ...(entryCount !== undefined ? { entryCount } : {}),
    totalEntries: summary.totalEntries,
    totalFiles: summary.totalFiles,
    totalDirectories: summary.totalDirectories,
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
    ...(summary.skippedInaccessible ? { skippedInaccessible: summary.skippedInaccessible } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

async function handleListDirectory(
  args: z.infer<typeof ListDirectoryInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: Parameters<typeof putResource>[0]['store'],
): Promise<ToolResponse<z.infer<typeof ListDirectoryOutputSchema>>> {
  const dirPath = pathGuard.resolvePathOrRoot(args.path);
  const pageSize = args.maxEntries;
  const options: ListDirectoryOptions = {
    includeHidden: args.includeHidden,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    sortBy: args.sortBy,
    includeSymlinkTargets: args.includeSymlinkTargets,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
    maxEntries: MAX_LIST_ENTRIES,
    ...(args.pattern !== undefined ? { pattern: args.pattern } : {}),
    ...(signal ? { signal } : {}),
  };
  const fingerprint = buildListFingerprint(args, pathGuard);

  let result: Awaited<ReturnType<typeof listDirectory>>;
  let cursorOffset = 0;
  let snapshotId: string | undefined;

  if (args.cursor) {
    const cursor = decodeListCursor(args.cursor);
    const snapshot = listSnapshots.get(cursor.snapshotId);
    if (snapshot?.fingerprint !== fingerprint) {
      throw new McpError(ErrorCode.INVALID_INPUT, 'Invalid or expired cursor.');
    }

    const { offset, snapshotId: storedSnapshotId } = cursor;
    cursorOffset = offset;
    snapshotId = storedSnapshotId;
    result = {
      path: snapshot.path,
      entries: snapshot.entries,
      summary: snapshot.summary,
    };
  } else {
    result = await listDirectory(dirPath, pathGuard, options);
  }

  const displayEntries = result.entries.slice(cursorOffset, cursorOffset + pageSize);
  if (!args.cursor && displayEntries.length < result.entries.length) {
    snapshotId = storeListSnapshot({
      path: result.path,
      entries: result.entries,
      summary: result.summary,
      fingerprint,
    });
  }

  const nextCursor = resolveNextListCursor(
    snapshotId,
    cursorOffset,
    displayEntries.length,
    result.entries.length,
  );

  // Store full listing in resource store if available
  let resourceUri: string | undefined;
  if (resourceStore) {
    // Create full listing JSON with all entries
    const fullListing = result.entries.map((entry) => buildStructuredListEntry(entry));

    const jsonContent = JSON.stringify(fullListing, null, 2);
    const dirName = basename(result.path) || 'listing';
    const fileName = `${dirName}-listing.json`;

    const { entry, link } = putResource({
      store: resourceStore,
      name: fileName,
      mimeType: 'application/json',
      kind: 'text',
      content: jsonContent,
    });

    resourceUri = entry.uri;

    // Build summary with entry counts
    const fullEntrySummary = buildEntrySummaryPart(result.entries);
    const summaryText = buildListSummaryText(result.path, result.entries.length) + fullEntrySummary;

    const structured = buildStructuredListResult(
      { ...result, entries: displayEntries },
      nextCursor,
      resourceUri,
      result.entries.length,
    );

    return buildResourceResponse({
      summary: summaryText,
      resources: [link],
      structured,
    });
  }

  // Fallback to old behavior if resource store is not available
  const displayResult = { ...result, entries: displayEntries };
  return buildToolResponse(
    buildListTextResult(displayResult, nextCursor),
    buildStructuredListResult(displayResult, nextCursor),
  );
}

type ListDirInput = z.infer<typeof ListDirectoryInputSchema>;
type ListDirOutput = z.infer<typeof ListDirectoryOutputSchema>;

export const LIST_DIRECTORY = defineTool<ListDirInput, ListDirOutput>({
  contract: LIST_DIRECTORY_TOOL,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  run: (args, ctx) => handleListDirectory(args, ctx.pathGuard, ctx.signal, ctx.resourceStore),
  progressMessage: (args) =>
    `${LIST_DIRECTORY_TOOL.title}: ${args.path ? basename(args.path) : '.'}`,
  completionMessage: (args: ListDirInput, result: ToolResult<ListDirOutput>): string => {
    const base = args.path ? basename(args.path) : '.';
    if (result.isError) return `${LIST_DIRECTORY_TOOL.title}: ${base} • ${result.errorCode}`;
    const sc = result.structuredContent;
    const count = sc.entryCount ?? sc.totalEntries ?? 0;
    return `${LIST_DIRECTORY_TOOL.title}: ${base} • ${count} ${count === 1 ? 'entry' : 'entries'}`;
  },
});
