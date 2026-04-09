import type { Stats } from 'node:fs';
import { glob as fsGlob, lstat, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  getToolContextSnapshot,
  publishOpsTraceEnd,
  publishOpsTraceError,
  publishOpsTraceStart,
  shouldPublishOpsTrace,
  startPerfMeasure,
} from '../observability.js';
import { toPosixPath } from '../paths.js';
import { isRecord } from '../utils.js';
import type { DirentLike } from './core.js';

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

function buildHiddenPatterns(
  normalizedPattern: string,
  maxDepth: number
): readonly string[] {
  const patterns = new Set<string>([normalizedPattern]);
  const { prefix, remainder } = splitPatternPrefix(normalizedPattern);

  if (remainder.length > 0) {
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

  if (remainder.startsWith('**/')) {
    const afterGlobstar = remainder.slice(3);
    const addDotFile =
      afterGlobstar.length > 0 && afterGlobstar.charCodeAt(0) !== DOT_CHAR_CODE;

    let depthPrefix = '';
    for (let depth = 0; depth <= maxDepth; depth++) {
      patterns.add(`${prefix}${depthPrefix}.*/**/${afterGlobstar}`);
      if (addDotFile) patterns.add(`${prefix}${depthPrefix}.${afterGlobstar}`);
      depthPrefix += '*/';
    }
  }

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
    throw new TypeError(
      'globEntries: options.excludePatterns must be an array of strings'
    );
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
    throw new TypeError(
      'globEntries: options.maxDepth must be a finite number'
    );
  }

  if (
    opts.suppressErrors !== undefined &&
    typeof opts.suppressErrors !== 'boolean'
  ) {
    throw new TypeError(
      'globEntries: options.suppressErrors must be a boolean'
    );
  }
}

function normalizeOptions(options: GlobEntriesOptions): NormalizedGlob {
  const cwd = resolve(options.cwd);
  const normalizedPattern = normalizePattern(
    options.pattern,
    options.baseNameMatch
  );

  const patterns = options.includeHidden
    ? buildHiddenPatterns(
        normalizedPattern,
        options.maxDepth ?? DEFAULT_MAX_HIDDEN_DEPTH
      )
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
  onlyFiles: boolean
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
      ? await stat(absolutePath)
      : await lstat(absolutePath);

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

  let buffer: string[] = [];

  const flush = async function* (): AsyncGenerator<GlobEntry> {
    if (buffer.length === 0) return;

    // Process buffer concurrently
    const currentBuffer = buffer;
    buffer = [];
    const results = await Promise.all(
      currentBuffer.map((match) =>
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
      )
    );

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
interface GlobConfig {
  cwd: string;
  pattern: string;
  excludePatterns?: readonly string[];
  includeHidden?: boolean;
  baseNameMatch?: boolean;
  caseSensitiveMatch?: boolean; // Default true if undefined
  followSymbolicLinks?: boolean; // Default false
  onlyFiles?: boolean; // Default true
  stats?: boolean; // Default false
  maxDepth?: number;
  suppressErrors?: boolean;
}

/**
 * Builds standard options for globEntries to ensure consistency across search tools.
 */
export function buildGlobOptions(
  config: GlobConfig
): Parameters<typeof globEntries>[0] {
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
