import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import { glob as fsGlob } from 'node:fs/promises';

import {
  getToolContextSnapshot,
  publishOpsTraceEnd,
  publishOpsTraceError,
  publishOpsTraceStart,
  shouldPublishOpsTrace,
  startPerfMeasure,
} from '../observability.js';
import { toPosixPath } from '../path-format.js';
import { isRecord } from '../type-guards.js';

interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function resolveEntryType(
  dirent: DirentLike
): 'file' | 'directory' | 'symlink' | 'other' {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isFile()) return 'file';
  return 'other';
}

interface GlobDirentLike extends DirentLike {
  name: string;
  parentPath?: string;
}

interface GlobEntry {
  path: string;
  relativePath?: string;
  dirent: DirentLike;
  stats?: Stats;
}

export interface GlobEntriesOptions {
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

function normalizeIgnorePatterns(
  patterns: readonly string[]
): readonly string[] {
  return patterns.map(toPosixPath);
}

function splitPatternPrefix(normalizedPattern: string): {
  prefix: string;
  remainder: string;
} {
  if (!GLOB_MAGIC_RE.test(normalizedPattern)) {
    return { prefix: '', remainder: normalizedPattern };
  }

  const segments = normalizedPattern.split(SEP);
  const len = segments.length;
  let splitIndex = len;

  for (let i = 0; i < len; i++) {
    const seg = segments[i];
    if (seg && GLOB_MAGIC_RE.test(seg)) {
      splitIndex = i;
      break;
    }
  }

  if (splitIndex === 0) {
    return { prefix: '', remainder: normalizedPattern };
  }

  if (splitIndex >= len) {
    const prefix = segments.slice(0, len - 1).join(SEP);
    const last = segments[len - 1];
    return {
      prefix: prefix ? prefix + SEP : '',
      remainder: last ?? '',
    };
  }

  return {
    prefix: segments.slice(0, splitIndex).join(SEP) + SEP,
    remainder: segments.slice(splitIndex).join(SEP),
  };
}

function addDotfileCandidates(
  patterns: Set<string>,
  prefix: string,
  remainderSegments: string[]
): void {
  const firstCandidateIndex = remainderSegments.findIndex(
    (segment) => segment !== '**' && segment.length > 0
  );

  if (firstCandidateIndex !== -1) {
    const original = remainderSegments[firstCandidateIndex];
    if (original && original.charCodeAt(0) !== DOT_CHAR_CODE) {
      const newSegments = remainderSegments.slice();
      newSegments[firstCandidateIndex] = `.${original}`;
      patterns.add(`${prefix}${newSegments.join(SEP)}`);
    }
  }
}

function addGlobstarCandidates(
  patterns: Set<string>,
  prefix: string,
  remainder: string,
  maxDepth: number
): void {
  const afterGlobstar = remainder.slice(3);
  const addDotFile =
    afterGlobstar.length > 0 && afterGlobstar.charCodeAt(0) !== DOT_CHAR_CODE;
  let depthPrefix = '';
  for (let depth = 0; depth <= maxDepth; depth++) {
    patterns.add(`${prefix}${depthPrefix}.*/**/${afterGlobstar}`);
    if (addDotFile) {
      patterns.add(`${prefix}${depthPrefix}.${afterGlobstar}`);
    }
    depthPrefix += '*/';
  }
}

function buildHiddenPatterns(
  normalizedPattern: string,
  maxDepth: number
): readonly string[] {
  const patterns = new Set<string>();
  patterns.add(normalizedPattern);

  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  if (remainder.length > 0) {
    const remainderSegments = remainder.split(SEP);
    addDotfileCandidates(patterns, prefix, remainderSegments);
  }

  if (remainder.startsWith('**/')) {
    addGlobstarCandidates(patterns, prefix, remainder, maxDepth);
  }

  return Array.from(patterns);
}

function shouldUseGlobDirents(options: GlobEntriesOptions): boolean {
  return !options.stats && !options.followSymbolicLinks;
}

function assertOptionString(
  options: Record<string, unknown>,
  key: 'cwd' | 'pattern'
): void {
  if (typeof options[key] !== 'string') {
    throw new TypeError(`globEntries: options.${key} must be a string`);
  }
}

function assertExcludePatternsOption(options: Record<string, unknown>): void {
  if (!Array.isArray(options.excludePatterns)) {
    throw new TypeError(
      'globEntries: options.excludePatterns must be an array'
    );
  }

  for (const pattern of options.excludePatterns) {
    if (typeof pattern !== 'string') {
      throw new TypeError(
        'globEntries: options.excludePatterns must contain only strings'
      );
    }
  }
}

function assertBooleanOptions(options: Record<string, unknown>): void {
  for (const key of GLOB_BOOLEAN_OPTION_KEYS) {
    if (typeof options[key] !== 'boolean') {
      throw new TypeError(`globEntries: options.${key} must be a boolean`);
    }
  }
}

function assertOptionalMaxDepth(options: Record<string, unknown>): void {
  const { maxDepth } = options;
  if (maxDepth === undefined) return;
  if (typeof maxDepth !== 'number' || !Number.isFinite(maxDepth)) {
    throw new TypeError(
      'globEntries: options.maxDepth must be a finite number'
    );
  }
}

function assertOptionalSuppressErrors(options: Record<string, unknown>): void {
  const { suppressErrors } = options;
  if (suppressErrors === undefined) return;
  if (typeof suppressErrors !== 'boolean') {
    throw new TypeError(
      'globEntries: options.suppressErrors must be a boolean'
    );
  }
}

function assertOptionsShape(options: GlobEntriesOptions): void {
  const unknownOptions: unknown = options;

  if (unknownOptions === null || typeof unknownOptions !== 'object') {
    throw new TypeError('globEntries: options must be an object');
  }

  const o = unknownOptions as Record<string, unknown>;
  assertOptionString(o, 'cwd');
  assertOptionString(o, 'pattern');
  assertExcludePatternsOption(o);
  assertBooleanOptions(o);
  assertOptionalMaxDepth(o);
  assertOptionalSuppressErrors(o);
}

function normalizeOptions(options: GlobEntriesOptions): NormalizedGlob {
  const cwd = path.resolve(options.cwd);
  const normalizedPattern = normalizePattern(
    options.pattern,
    options.baseNameMatch
  );

  const maxHiddenDepth = options.maxDepth ?? DEFAULT_MAX_HIDDEN_DEPTH;
  const patterns = options.includeHidden
    ? buildHiddenPatterns(normalizedPattern, maxHiddenDepth)
    : [normalizedPattern];

  const normalized: NormalizedGlob = {
    cwd,
    patterns,
    exclude: normalizeIgnorePatterns(options.excludePatterns),
    useDirents: shouldUseGlobDirents(options),
    suppressErrors: options.suppressErrors ?? false,
  };

  if (options.maxDepth !== undefined) {
    normalized.maxDepth = options.maxDepth;
  }

  return normalized;
}

function getRelativeDepth(relativePath: string): number {
  if (relativePath.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < relativePath.length; i++) {
    const code = relativePath.charCodeAt(i);
    if (code === 47 || code === 92) {
      count++;
    }
  }
  return count + 1;
}

function isGlobDirentLike(value: unknown): value is GlobDirentLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    typeof value.isDirectory === 'function' &&
    typeof value.isFile === 'function' &&
    typeof value.isSymbolicLink === 'function'
  );
}

function resolveDirentBase(
  cwd: string,
  parentPath: string | undefined
): string {
  if (!parentPath) return cwd;
  return path.isAbsolute(parentPath)
    ? parentPath
    : path.resolve(cwd, parentPath);
}

function resolveStringMatchPath(cwd: string, match: string): string {
  return path.isAbsolute(match) ? match : path.resolve(cwd, match);
}

function* processDirentMatch(
  match: GlobDirentLike,
  cwd: string,
  maxDepth: number | undefined,
  seen: Set<string>,
  onlyFiles: boolean
): Generator<GlobEntry> {
  const base = resolveDirentBase(cwd, match.parentPath);
  const absolutePath = path.resolve(base, match.name);

  if (maxDepth !== undefined) {
    const rel = path.relative(cwd, absolutePath);
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
  suppressErrors: boolean
): Promise<GlobEntry | null> {
  if (maxDepth !== undefined) {
    const depth = getRelativeDepth(match);
    if (depth > maxDepth) return null;
  }

  const absolutePath = resolveStringMatchPath(cwd, match);

  if (seen.has(absolutePath)) return null;
  seen.add(absolutePath);

  try {
    const stats = followSymlinks
      ? await fs.stat(absolutePath)
      : await fs.lstat(absolutePath);

    if (onlyFiles && !stats.isFile()) return null;

    const entry: GlobEntry = { path: absolutePath, dirent: stats };
    if (!path.isAbsolute(match)) {
      entry.relativePath = match;
    }
    if (returnStats) entry.stats = stats;
    return entry;
  } catch (error) {
    if (!suppressErrors) throw error;
    return null;
  }
}

async function* processIterable(
  iterable: AsyncIterable<GlobMatch>,
  context: {
    cwd: string;
    maxDepth: number | undefined;
    seen: Set<string>;
    onlyFiles: boolean;
    followSymlinks: boolean;
    returnStats: boolean;
    suppressErrors: boolean;
  }
): AsyncGenerator<GlobEntry> {
  const {
    cwd,
    maxDepth,
    seen,
    onlyFiles,
    followSymlinks,
    returnStats,
    suppressErrors,
  } = context;

  const buffer: string[] = [];

  const flush = async function* (): AsyncGenerator<GlobEntry> {
    if (buffer.length === 0) return;
    const requests: Promise<GlobEntry | null>[] = [];
    for (const match of buffer) {
      requests.push(
        resolveStringMatch(
          match,
          cwd,
          maxDepth,
          seen,
          onlyFiles,
          followSymlinks,
          returnStats,
          suppressErrors
        )
      );
    }
    buffer.length = 0;
    const results = await Promise.all(requests);
    for (const entry of results) {
      if (entry !== null) yield entry;
    }
  };

  try {
    for await (const match of iterable) {
      if (typeof match === 'string') {
        buffer.push(match);
        if (buffer.length >= GLOB_BATCH_CONCURRENCY) {
          yield* flush();
        }
        continue;
      }

      if (buffer.length > 0) yield* flush();

      if (isGlobDirentLike(match)) {
        yield* processDirentMatch(match, cwd, maxDepth, seen, onlyFiles);
      }
    }
    yield* flush();
  } catch (error) {
    if (!suppressErrors) throw error;
  }
}

async function* nativeGlobEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const plan = normalizeOptions(options);
  const seen = new Set<string>();

  const { cwd, maxDepth, suppressErrors } = plan;
  const {
    onlyFiles,
    stats: returnStats,
    followSymbolicLinks: followSymlinks,
  } = options;

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

    yield* processIterable(iterable, context);
  }
}

export async function* globEntries(
  options: GlobEntriesOptions
): AsyncGenerator<GlobEntry> {
  const engine = 'node:fs/promises.glob';

  const endMeasure = startPerfMeasure('globEntries', { engine });
  const toolContext = getToolContextSnapshot();
  const traceContext = shouldPublishOpsTrace()
    ? {
        op: 'globEntries',
        engine,
        ...(toolContext
          ? { tool: toolContext.tool, path: toolContext.path }
          : {}),
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
