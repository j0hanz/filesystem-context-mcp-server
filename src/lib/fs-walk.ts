import type { Stats } from 'node:fs';
import { glob as fsGlob, lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import ignore, { type Ignore } from 'ignore';

import type { FileType } from '../config.js';
import { isNodeError } from './errors.js';
import {
  getToolContextSnapshot,
  publishOpsTraceEnd,
  publishOpsTraceError,
  publishOpsTraceStart,
  shouldPublishOpsTrace,
  startPerfMeasure,
} from './observability.js';
import { toPosixPath } from './path-guard.js';

export function getFileType(stats: Stats): FileType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export function needsStatsForSort(sortBy: string): boolean {
  return sortBy === 'size' || sortBy === 'modified';
}

const collator = new Intl.Collator(undefined, { numeric: true });

export function withOptionalStoppedReason<T extends object, R extends string>(
  summary: T,
  stoppedReason: R | undefined,
): T & { stoppedReason?: R } {
  if (stoppedReason === undefined) {
    return summary;
  }
  return { ...summary, stoppedReason };
}

export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function resolveStopReason<R extends string>(options: {
  signal: AbortSignal;
  current: number;
  max: number;
  abortedReason: R;
  maxReason: R;
}): R | undefined {
  if (options.signal.aborted) return options.abortedReason;
  if (options.current >= options.max) return options.maxReason;
  return undefined;
}

export function compareStringValues(left?: string, right?: string): number {
  if (left === right) return 0;
  return collator.compare(left ?? '', right ?? '');
}

export function compareOptionalNumberDesc(
  left: number | undefined,
  right: number | undefined,
  tieBreak: () => number,
): number {
  const diff = (right ?? 0) - (left ?? 0);
  if (diff !== 0) return diff;
  return tieBreak();
}

export function stableSortByDerivedString<T>(
  items: T[],
  derive: (item: T) => string,
  tieBreak: (left: T, right: T) => number,
): void {
  const len = items.length;
  if (len <= 1) return;

  const derived = new Array<string>(len);
  const indices = new Int32Array(len);

  for (let i = 0; i < len; i++) {
    const item = items[i];
    if (item !== undefined) {
      derived[i] = derive(item);
    }
    indices[i] = i;
  }

  indices.sort((a, b) => {
    const itemA = items[a];
    const itemB = items[b];

    if (itemA === undefined && itemB === undefined) return 0;
    if (itemA === undefined) return 1;
    if (itemB === undefined) return -1;

    const derivedA = derived[a] ?? '';
    const derivedB = derived[b] ?? '';

    if (derivedA !== derivedB) {
      const derivedCompare = collator.compare(derivedA, derivedB);
      if (derivedCompare !== 0) return derivedCompare;
    }

    const tiedCompare = tieBreak(itemA, itemB);
    if (tiedCompare !== 0) return tiedCompare;

    return a - b;
  });

  const sortedItems = new Array<T>(len);
  for (let i = 0; i < len; i++) {
    const idx = indices[i];
    sortedItems[i] = items[idx ?? 0] as T;
  }
  for (let i = 0; i < len; i++) {
    items[i] = sortedItems[i] as T;
  }
}

interface IndexedValue<T> {
  index: number;
  value: T;
}

interface IndexedError {
  index: number;
  error: Error;
}

export function applyIndexedValues<T>(output: T[], results: readonly IndexedValue<T>[]): void {
  for (const result of results) {
    if (result.index < 0 || result.index >= output.length) continue;
    output[result.index] = result.value;
  }
}

export function applyIndexedErrors<T>(options: {
  output: T[];
  errors: readonly IndexedError[];
  resolveIndex: (failureIndex: number) => number | undefined;
  buildValue: (resolvedIndex: number, error: Error) => T;
}): void {
  const { output, errors, resolveIndex, buildValue } = options;
  for (const failure of errors) {
    const resolvedIndex = resolveIndex(failure.index);
    if (resolvedIndex === undefined) continue;
    if (resolvedIndex < 0 || resolvedIndex >= output.length) continue;
    output[resolvedIndex] = buildValue(resolvedIndex, failure.error);
  }
}

export interface EntryAccessDependencies {
  normalizePath: (inputPath: string) => string;
  isPathWithinDirectories: (normalizedPath: string, rootDirectories: readonly string[]) => boolean;
  isSensitivePath: (requestedPath: string, resolvedPath: string) => boolean;
  validateSymlinkPath: (
    inputPath: string,
    signal: AbortSignal,
  ) => Promise<{ requestedPath: string; resolvedPath: string }>;
}

export async function isEntryAccessibleByType(
  entryPath: string,
  entryType: EntryType,
  rootDirectories: readonly string[],
  signal: AbortSignal,
  deps: EntryAccessDependencies,
): Promise<boolean> {
  if (entryType !== 'symlink') {
    const normalizedPath = deps.normalizePath(entryPath);
    if (!deps.isPathWithinDirectories(normalizedPath, rootDirectories)) {
      return false;
    }
    return !deps.isSensitivePath(entryPath, normalizedPath);
  }

  try {
    const validated = await deps.validateSymlinkPath(entryPath, signal);
    return !deps.isSensitivePath(validated.requestedPath, validated.resolvedPath);
  } catch {
    return false;
  }
}

function parseGitignoreLines(contents: string): string[] {
  const lines: string[] = [];
  const parts = contents.split(/\r?\n/u);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      lines.push(trimmed);
    }
  }
  return lines;
}

export async function loadRootGitignore(
  root: string,
  signal?: AbortSignal,
): Promise<Ignore | null> {
  const gitignorePath = join(root, '.gitignore');

  try {
    const contents = await readFile(gitignorePath, {
      encoding: 'utf-8',
      signal,
    });
    const matcher = ignore();
    matcher.add(parseGitignoreLines(contents));
    return matcher;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function isIgnoredByGitignore(
  matcher: Ignore,
  root: string,
  absolutePath: string,
  options: { isDirectory?: boolean; relativePath?: string } = {},
): boolean {
  let { relativePath } = options;
  relativePath ??= relative(root, absolutePath);
  if (relativePath.length === 0) return false;

  const normalized = toPosixPath(relativePath);
  if (options.isDirectory) {
    return matcher.ignores(normalized.endsWith('/') ? normalized : `${normalized}/`);
  }
  return matcher.ignores(normalized);
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath?: string;
}

export interface GlobEntry {
  path: string;
  relativePath?: string;
  dirent: DirentLike;
  stats?: Stats;
}

interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  excludePatterns: readonly string[];
  includeHidden: boolean;
  baseNameMatch: boolean;
  caseSensitiveMatch: boolean;
  maxDepth?: number;
  followSymbolicLinks: boolean;
  onlyFiles: boolean;
  stats: boolean;
  suppressErrors?: boolean;
}

type GlobMatch = string | GlobDirentLike;

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  exclude: readonly string[];
  useDirents: boolean;
  suppressErrors: boolean;
  maxDepth?: number;
}

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
const DEFAULT_MAX_HIDDEN_DEPTH = 10;
const GLOB_BATCH_CONCURRENCY = 64;
const SEP = '/';
const DOT_CHAR_CODE = 46;
const GLOB_BOOLEAN_OPTION_KEYS: readonly (keyof GlobEntriesOptions)[] = [
  'includeHidden',
  'baseNameMatch',
  'caseSensitiveMatch',
  'followSymbolicLinks',
  'onlyFiles',
  'stats',
];

function normalizePattern(pattern: string, baseNameMatch: boolean): string {
  const normalized = toPosixPath(pattern);

  if (!baseNameMatch) return normalized;
  if (normalized.includes(SEP)) return normalized;
  return `**/${normalized}`;
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
  if (!GLOB_MAGIC_RE.test(normalizedPattern)) {
    return { prefix: '', remainder: normalizedPattern };
  }

  const segments = normalizedPattern.split(SEP);
  const splitIndex = segments.findIndex((seg) => GLOB_MAGIC_RE.test(seg));

  if (splitIndex <= 0) {
    return { prefix: '', remainder: normalizedPattern };
  }

  return {
    prefix: segments.slice(0, splitIndex).join(SEP) + SEP,
    remainder: segments.slice(splitIndex).join(SEP),
  };
}

function addFirstDotSegment(patterns: Set<string>, prefix: string, remainder: string): void {
  if (remainder.length === 0) return;
  const segments = remainder.split(SEP);
  const idx = segments.findIndex((seg) => seg !== '**' && seg.length > 0);

  if (idx !== -1) {
    const original = segments[idx];
    if (original && original.charCodeAt(0) !== DOT_CHAR_CODE) {
      const newSegments = [...segments];
      newSegments[idx] = `.${original}`;
      patterns.add(`${prefix}${newSegments.join(SEP)}`);
    }
  }
}

function expandHiddenGlobstars(
  patterns: Set<string>,
  prefix: string,
  remainder: string,
  maxDepth: number,
): void {
  if (!remainder.startsWith('**/')) return;

  const afterGlobstar = remainder.slice(3);
  const addDotFile = afterGlobstar.length > 0 && afterGlobstar.charCodeAt(0) !== DOT_CHAR_CODE;

  let depthPrefix = '';
  for (let depth = 0; depth <= maxDepth; depth++) {
    patterns.add(`${prefix}${depthPrefix}.*/**/${afterGlobstar}`);
    if (addDotFile) patterns.add(`${prefix}${depthPrefix}.${afterGlobstar}`);
    depthPrefix += '*/';
  }
}

function buildHiddenPatterns(normalizedPattern: string, maxDepth: number): readonly string[] {
  const patterns = new Set<string>([normalizedPattern]);
  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  addFirstDotSegment(patterns, prefix, remainder);
  expandHiddenGlobstars(patterns, prefix, remainder, maxDepth);

  return Array.from(patterns);
}

function assertOptionsShape(options: GlobEntriesOptions): void {
  const optsUnknown = options as unknown;
  if (typeof optsUnknown !== 'object' || optsUnknown === null) {
    throw new TypeError('globEntries: options must be an object');
  }

  const opts = optsUnknown as Record<string, unknown>;

  if (typeof opts.cwd !== 'string')
    throw new TypeError('globEntries: options.cwd must be a string');
  if (typeof opts.pattern !== 'string')
    throw new TypeError('globEntries: options.pattern must be a string');

  if (
    !Array.isArray(opts.excludePatterns) ||
    opts.excludePatterns.some((p) => typeof p !== 'string')
  ) {
    throw new TypeError('globEntries: options.excludePatterns must be an array of strings');
  }

  for (const key of GLOB_BOOLEAN_OPTION_KEYS) {
    if (typeof opts[key] !== 'boolean') {
      throw new TypeError(`globEntries: options.${key} must be a boolean`);
    }
  }

  if (
    opts.maxDepth !== undefined &&
    (!Number.isFinite(opts.maxDepth) || typeof opts.maxDepth !== 'number')
  ) {
    throw new TypeError('globEntries: options.maxDepth must be a finite number');
  }

  if (opts.suppressErrors !== undefined && typeof opts.suppressErrors !== 'boolean') {
    throw new TypeError('globEntries: options.suppressErrors must be a boolean');
  }
}

function normalizeGlobOptions(options: GlobEntriesOptions): NormalizedGlob {
  const cwd = resolve(options.cwd);
  const normalizedPattern = normalizePattern(options.pattern, options.baseNameMatch);

  const patterns = options.includeHidden
    ? buildHiddenPatterns(normalizedPattern, options.maxDepth ?? DEFAULT_MAX_HIDDEN_DEPTH)
    : [normalizedPattern];

  const normalized: NormalizedGlob = {
    cwd,
    patterns,
    exclude: options.excludePatterns.map(toPosixPath),
    useDirents: !options.stats && !options.followSymbolicLinks,
    suppressErrors: options.suppressErrors ?? false,
  };

  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }

  return normalized;
}

function getRelativeDepth(relativePath: string): number {
  const len = relativePath.length;
  if (len === 0) return 0;
  let count = 0;
  for (let i = 0; i < len; i++) {
    const code = relativePath.charCodeAt(i);
    if (code === 47 || code === 92) {
      count++;
    }
  }
  return count + 1;
}

function resolveDirentBase(cwd: string, parentPath: string | undefined): string {
  if (!parentPath) return cwd;
  return isAbsolute(parentPath) ? parentPath : resolve(cwd, parentPath);
}

function resolveStringMatchPath(cwd: string, match: string): string {
  return isAbsolute(match) ? match : resolve(cwd, match);
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
): Generator<GlobEntry> {
  const base = resolveDirentBase(cwd, match.parentPath);
  const absolutePath = resolve(base, match.name);

  if (maxDepth !== undefined) {
    const rel = relative(cwd, absolutePath);
    if (getRelativeDepth(rel) > maxDepth) return;
  }

  if (seen.has(absolutePath)) return;
  seen.add(absolutePath);

  if (onlyFiles && !match.isFile()) return;
  yield { path: absolutePath, dirent: match };
}

async function resolveStringMatch(
  match: string,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean,
  followSymlinks: boolean,
  returnStats: boolean,
  suppressErrors: boolean,
): Promise<GlobEntry | null> {
  if (maxDepth !== undefined) {
    const depth = getRelativeDepth(match);
    if (depth > maxDepth) return null;
  }

  const absolutePath = resolveStringMatchPath(cwd, match);

  if (seen.has(absolutePath)) return null;
  seen.add(absolutePath);

  try {
    const stats = followSymlinks ? await stat(absolutePath) : await lstat(absolutePath);

    if (onlyFiles && !stats.isFile()) return null;

    const entry: GlobEntry = { path: absolutePath, dirent: stats };
    if (!isAbsolute(match)) {
      entry.relativePath = match;
    }
    if (returnStats) entry.stats = stats;
    return entry;
  } catch (error) {
    if (!suppressErrors) throw error;
    return null;
  }
}

interface ProcessContext {
  cwd: string;
  maxDepth: number | undefined;
  seen: Set<string>;
  onlyFiles: boolean;
  followSymlinks: boolean;
  returnStats: boolean;
  suppressErrors: boolean;
}

class AsyncGlobBatchQueue {
  private buffer: string[];
  private bufferLength = 0;

  constructor(private readonly context: ProcessContext) {
    this.buffer = new Array<string>(GLOB_BATCH_CONCURRENCY);
  }

  add(match: string): void {
    this.buffer[this.bufferLength++] = match;
  }

  isFull(): boolean {
    return this.bufferLength >= GLOB_BATCH_CONCURRENCY;
  }

  hasItems(): boolean {
    return this.bufferLength > 0;
  }

  async *flush(): AsyncGenerator<GlobEntry> {
    if (this.bufferLength === 0) return;

    const count = this.bufferLength;
    this.bufferLength = 0;

    const promises = new Array<Promise<GlobEntry | null>>(count);
    for (let i = 0; i < count; i++) {
      const matchPath = this.buffer[i];
      promises[i] = resolveStringMatch(
        matchPath ?? '',
        this.context.cwd,
        this.context.maxDepth,
        this.context.seen,
        this.context.onlyFiles,
        this.context.followSymlinks,
        this.context.returnStats,
        this.context.suppressErrors,
      );
    }

    const results = await Promise.all(promises);

    for (let i = 0; i < count; i++) {
      const entry = results[i];
      if (entry !== null && entry !== undefined) yield entry;
    }
  }
}

async function* nativeGlobEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();

  const { cwd, maxDepth, suppressErrors } = plan;
  const { onlyFiles, stats: returnStats, followSymbolicLinks: followSymlinks } = options;

  const context = {
    cwd,
    maxDepth,
    seen,
    onlyFiles,
    followSymlinks,
    returnStats,
    suppressErrors,
  };

  for (const pattern of plan.patterns) {
    let iterable: AsyncIterable<GlobMatch>;
    try {
      iterable = fsGlob(pattern, {
        cwd,
        exclude: plan.exclude,
        withFileTypes: plan.useDirents,
      }) as AsyncIterable<GlobMatch>;
    } catch (error) {
      if (suppressErrors) continue;
      throw error;
    }

    if (plan.useDirents) {
      try {
        for await (const match of iterable) {
          yield* processDirentMatch(
            match as GlobDirentLike,
            context.cwd,
            context.maxDepth,
            context.seen,
            context.onlyFiles,
          );
        }
      } catch (error) {
        if (!suppressErrors) throw error;
      }
    } else {
      const queue = new AsyncGlobBatchQueue(context);
      try {
        for await (const match of iterable) {
          queue.add(match as string);
          if (queue.isFull()) {
            yield* queue.flush();
          }
        }
        yield* queue.flush();
      } catch (error) {
        if (!suppressErrors) throw error;
      }
    }
  }
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  const engine = 'node:fs/promises.glob';

  const endMeasure = startPerfMeasure('globEntries', { engine });
  const toolContext = getToolContextSnapshot();
  const traceContext = shouldPublishOpsTrace()
    ? {
        op: 'globEntries',
        engine,
        ...(toolContext ? { tool: toolContext.tool, path: toolContext.path } : {}),
      }
    : undefined;

  if (traceContext) publishOpsTraceStart(traceContext);

  let ok = false;
  try {
    assertOptionsShape(options);
    yield* nativeGlobEntries(options);
    ok = true;
  } catch (error: unknown) {
    if (traceContext) publishOpsTraceError(traceContext, error);
    throw error;
  } finally {
    if (traceContext) publishOpsTraceEnd(traceContext);
    endMeasure?.(ok);
  }
}

interface GlobConfig {
  cwd: string;
  pattern: string;
  excludePatterns?: readonly string[];
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  caseSensitiveMatch?: boolean;
  followSymbolicLinks?: boolean;
  onlyFiles?: boolean;
  stats?: boolean;
  maxDepth?: number;
  suppressErrors?: boolean;
}

export function buildGlobOptions(config: GlobConfig): Parameters<typeof globEntries>[0] {
  const options: Parameters<typeof globEntries>[0] = {
    cwd: config.cwd,
    pattern: config.pattern,
    excludePatterns: config.excludePatterns ?? [],
    includeHidden: config.includeHidden ?? false,
    baseNameMatch: config.baseNameMatch ?? false,
    caseSensitiveMatch: config.caseSensitiveMatch ?? true,
    followSymbolicLinks: config.followSymbolicLinks ?? false,
    onlyFiles: config.onlyFiles ?? true,
    stats: config.stats ?? false,
  };

  if (config.suppressErrors) {
    options.suppressErrors = config.suppressErrors;
  }

  if (config.maxDepth !== undefined) {
    options.maxDepth = config.maxDepth;
  }

  return options;
}
