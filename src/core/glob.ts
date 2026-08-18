import type { Stats } from 'node:fs';
import {
  glob as fsGlob,
  lstat as fsLstat,
  readFile as fsReadFile,
  stat as fsStat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { formatUnknownErrorMessage, isNodeError } from './errors.js';
import { Logger } from './observability.js';
import { toPosixPath } from './path.js';

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
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === 'ENOENT' ||
        error.code === 'EACCES' ||
        error.code === 'ELOOP' ||
        error.code === 'ACCESS_DENIED' ||
        error.code === 'SYMLINK_NOT_ALLOWED')
    ) {
      return false;
    }
    throw error;
  }
}

async function runConcurrentTasks(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      await tasks[i]?.();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, next));
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

export class GitignoreManager {
  private matchers = new Map<string, Ignore>();

  static async load(root: string, signal?: AbortSignal): Promise<GitignoreManager> {
    const manager = new GitignoreManager();
    try {
      const gitignorePaths: string[] = [];
      const gitignoreEntries = fsGlob('**/.gitignore', {
        cwd: root,
        exclude: (entry: string) => {
          const name = basename(entry);
          if (name === 'node_modules' || name === '.git' || name === '.hg' || name === '.svn') {
            return true;
          }
          return false;
        },
      });
      for await (const match of gitignoreEntries) {
        if (signal?.aborted) break;
        gitignorePaths.push(match);
      }

      await runConcurrentTasks(
        gitignorePaths.map((relPath) => async () => {
          const absPath = join(root, relPath);
          try {
            const contents = await fsReadFile(absPath, {
              encoding: 'utf-8',
              signal,
            });
            const matcher = ignore();
            matcher.add(parseGitignoreLines(contents));
            const dir = toPosixPath(dirname(relPath));
            manager.matchers.set(dir === '.' ? '' : dir, matcher);
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            Logger.warn(
              `Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`,
            );
          }
        }),
        GLOB_BATCH_CONCURRENCY,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      Logger.warn(
        `Failed to enumerate .gitignore files under ${root}: ${formatUnknownErrorMessage(error)}`,
      );
    }
    return manager;
  }

  size(): number {
    return this.matchers.size;
  }

  isIgnored(relativePath: string, isDirectory: boolean): boolean {
    const normalized = toPosixPath(relativePath);
    if (normalized === '' || normalized === '.') return false;
    const parts = normalized.split('/');

    // 1. Check parent directories first
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      if (this.checkPath(currentDir, true)) {
        return true;
      }
    }

    // 2. Check the file/directory itself
    return this.checkPath(normalized, isDirectory);
  }

  private checkPath(posixPath: string, isDirectory: boolean): boolean {
    const parts = posixPath.split('/');
    const pathToCheck = isDirectory
      ? posixPath.endsWith('/')
        ? posixPath
        : `${posixPath}/`
      : posixPath;

    let ignored = false;

    // Check root level
    const rootMatcher = this.matchers.get('');
    if (rootMatcher) {
      const res = rootMatcher.test(pathToCheck);
      if (res.ignored) ignored = true;
      if (res.unignored) ignored = false;
    }

    // Check subdirectories
    let currentDir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!part) continue;
      currentDir = currentDir ? `${currentDir}/${part}` : part;

      const matcher = this.matchers.get(currentDir);
      if (matcher) {
        const relParts = parts.slice(i + 1);
        const relPath = relParts.join('/');
        const relPathToCheck = isDirectory
          ? relPath.endsWith('/')
            ? relPath
            : `${relPath}/`
          : relPath;

        const res = matcher.test(relPathToCheck);
        if (res.ignored) ignored = true;
        if (res.unignored) ignored = false;
      }
    }

    return ignored;
  }
}

export async function loadRootGitignore(
  root: string,
  signal?: AbortSignal,
): Promise<GitignoreManager | null> {
  const manager = await GitignoreManager.load(root, signal);
  if (manager.size() === 0) {
    return null;
  }
  return manager;
}

export function isIgnoredByGitignore(
  matcher: GitignoreManager,
  root: string,
  absolutePath: string,
  options: { isDirectory?: boolean; relativePath?: string } = {},
): boolean {
  let { relativePath } = options;
  relativePath ??= relative(root, absolutePath);
  if (relativePath.length === 0) return false;
  return matcher.isIgnored(relativePath, Boolean(options.isDirectory));
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
  respectGitignore?: boolean;
}

type GlobMatch = string | GlobDirentLike;

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  exclude: readonly string[];
  useDirents: boolean;
  suppressErrors: boolean;
  maxDepth?: number;
  respectGitignore: boolean;
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

  if (typeof opts['cwd'] !== 'string')
    throw new TypeError('globEntries: options.cwd must be a string');
  if (typeof opts['pattern'] !== 'string')
    throw new TypeError('globEntries: options.pattern must be a string');

  if (
    !Array.isArray(opts['excludePatterns']) ||
    opts['excludePatterns'].some((p) => typeof p !== 'string')
  ) {
    throw new TypeError('globEntries: options.excludePatterns must be an array of strings');
  }

  for (const key of GLOB_BOOLEAN_OPTION_KEYS) {
    if (typeof opts[key] !== 'boolean') {
      throw new TypeError(`globEntries: options.${key} must be a boolean`);
    }
  }

  if (
    opts['maxDepth'] !== undefined &&
    (!Number.isFinite(opts['maxDepth']) || typeof opts['maxDepth'] !== 'number')
  ) {
    throw new TypeError('globEntries: options.maxDepth must be a finite number');
  }

  if (opts['suppressErrors'] !== undefined && typeof opts['suppressErrors'] !== 'boolean') {
    throw new TypeError('globEntries: options.suppressErrors must be a boolean');
  }

  if (opts['respectGitignore'] !== undefined && typeof opts['respectGitignore'] !== 'boolean') {
    throw new TypeError('globEntries: options.respectGitignore must be a boolean');
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
    respectGitignore: options.respectGitignore ?? false,
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
    const stats = followSymlinks ? await fsStat(absolutePath) : await fsLstat(absolutePath);

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
  private readonly context: ProcessContext;

  constructor(context: ProcessContext) {
    this.context = context;
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

function createExcludeFilter(
  cwd: string,
  excludePatterns: readonly string[],
  gitignoreMatcher?: GitignoreManager | null,
): ((match: GlobMatch) => boolean) | readonly string[] {
  if (!gitignoreMatcher) {
    return excludePatterns;
  }

  return (match: GlobMatch) => {
    const relPath =
      typeof match === 'string'
        ? match
        : match.parentPath
          ? relative(cwd, join(match.parentPath, match.name))
          : match.name;

    const posixRel = toPosixPath(relPath);

    // Gitignore check
    const isDir = typeof match === 'string' ? false : match.isDirectory();
    if (
      isIgnoredByGitignore(gitignoreMatcher, cwd, '', {
        relativePath: posixRel,
        isDirectory: isDir,
      })
    ) {
      return true;
    }

    // Also check explicit exclude patterns
    if (excludePatterns.length > 0) {
      for (const ex of excludePatterns) {
        if (posix.matchesGlob(posixRel, ex)) return true;
      }
    }

    return false;
  };
}

async function* processGlobPattern(
  pattern: string,
  plan: NormalizedGlob,
  context: ProcessContext,
  excludeFunc: ((match: GlobMatch) => boolean) | readonly string[],
  forceFileTypes: boolean,
): AsyncGenerator<GlobEntry> {
  const { cwd, suppressErrors } = plan;
  let iterable: AsyncIterable<GlobMatch>;
  try {
    iterable = fsGlob(pattern, {
      cwd,
      exclude: excludeFunc,
      withFileTypes: forceFileTypes,
    }) as AsyncIterable<GlobMatch>;
  } catch (error) {
    if (suppressErrors) return;
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
      Logger.warn(
        `globEntries: suppressed mid-walk error for pattern "${pattern}": ${formatUnknownErrorMessage(error)}`,
      );
    }
  } else {
    const queue = new AsyncGlobBatchQueue(context);
    try {
      for await (const match of iterable) {
        let strMatch: string;
        if (typeof match === 'string') {
          strMatch = match;
        } else {
          strMatch = match.parentPath
            ? relative(cwd, join(match.parentPath, match.name))
            : match.name;
        }
        queue.add(strMatch);
        if (queue.isFull()) {
          yield* queue.flush();
        }
      }
      yield* queue.flush();
    } catch (error) {
      if (!suppressErrors) throw error;
      Logger.warn(
        `globEntries: suppressed mid-walk error for pattern "${pattern}": ${formatUnknownErrorMessage(error)}`,
      );
    }
  }
}

async function* nativeGlobEntries(
  options: GlobEntriesOptions,
  gitignoreMatcher?: GitignoreManager | null,
): AsyncGenerator<GlobEntry> {
  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();

  const { cwd, maxDepth, suppressErrors } = plan;
  const { onlyFiles, stats: returnStats, followSymbolicLinks: followSymlinks } = options;

  const context: ProcessContext = {
    cwd,
    maxDepth,
    seen,
    onlyFiles,
    followSymlinks,
    returnStats,
    suppressErrors,
  };

  const forceFileTypes = plan.useDirents || Boolean(gitignoreMatcher);
  const excludeFunc = createExcludeFilter(cwd, plan.exclude, gitignoreMatcher);

  for (const pattern of plan.patterns) {
    yield* processGlobPattern(pattern, plan, context, excludeFunc, forceFileTypes);
  }
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
  assertOptionsShape(options);
  let gitignoreMatcher: GitignoreManager | null = null;
  if (options.respectGitignore) {
    gitignoreMatcher = await loadRootGitignore(options.cwd);
  }
  yield* nativeGlobEntries(options, gitignoreMatcher);
}

type GlobConfig = Partial<GlobEntriesOptions> & Pick<GlobEntriesOptions, 'cwd' | 'pattern'>;

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

  if (config.respectGitignore !== undefined) {
    options.respectGitignore = config.respectGitignore;
  }

  return options;
}

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/dist',
  '**/dist/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/.git',
  '**/.git/**',
  '**/.vscode',
  '**/.vscode/**',
  '**/.idea',
  '**/.idea/**',
  '**/.DS_Store',
  '**/.next',
  '**/.next/**',
  '**/.nuxt',
  '**/.nuxt/**',
  '**/.output',
  '**/.output/**',
  '**/.svelte-kit',
  '**/.svelte-kit/**',
  '**/.cache',
  '**/.cache/**',
  '**/.yarn',
  '**/.yarn/**',
  '**/jspm_packages',
  '**/jspm_packages/**',
  '**/bower_components',
  '**/bower_components/**',
  '**/out',
  '**/out/**',
  '**/tmp',
  '**/tmp/**',
  '**/.temp',
  '**/.temp/**',
  '**/npm-debug.log',
  '**/yarn-debug.log',
  '**/yarn-error.log',
  '**/Thumbs.db',
];
