import { glob as fsGlob, readFile as fsReadFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';

import type { Ignore } from 'ignore';
import ignore from 'ignore';

import { processInParallel } from './concurrency.js';
import { formatUnknownErrorMessage, isNodeError } from './errors.js';
import { Logger } from './observability.js';
import type { PathGuard } from './path.js';
import { isPathWithinDirectories, normalizePath, toPosixPath } from './path.js';
import type { EntryType } from './primitives.js';

export type { EntryType };

export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}

export async function isEntryAccessibleByType(
  entryPath: string,
  entryType: EntryType,
  rootDirectories: readonly string[],
  pathGuard: PathGuard,
): Promise<boolean> {
  const isSensitive = (requestedPath: string, resolvedPath: string): boolean =>
    pathGuard.isSensitive(requestedPath) || pathGuard.isSensitive(resolvedPath);

  if (entryType !== 'symlink') {
    const normalizedPath = normalizePath(entryPath);
    if (!isPathWithinDirectories(normalizedPath, rootDirectories)) {
      return false;
    }
    return !isSensitive(entryPath, normalizedPath);
  }

  try {
    const validated = await pathGuard.validateExistingPathDetailed(entryPath);
    return !isSensitive(validated.requestedPath, validated.resolvedPath);
  } catch (error) {
    if (
      isNodeError(error) &&
      (error.code === 'ENOENT' ||
        error.code === 'EACCES' ||
        error.code === 'ELOOP' ||
        error.code === 'ACCESS_DENIED' ||
        // A dangling symlink whose target path sits inside an allowed root
        // surfaces as FsError NOT_FOUND, not ENOENT. Skipping the entry is the
        // point of this list; rethrowing would fail the whole listing.
        error.code === 'NOT_FOUND' ||
        error.code === 'SYMLINK_NOT_ALLOWED')
    ) {
      return false;
    }
    throw error;
  }
}

async function loadGitignoreFiles(
  root: string,
  gitignorePaths: readonly string[],
  manager: GitignoreManager,
  signal?: AbortSignal,
): Promise<void> {
  await processInParallel(
    gitignorePaths,
    async (relPath) => {
      const absPath = join(root, relPath);
      try {
        const contents = await fsReadFile(absPath, { encoding: 'utf-8', signal });
        const matcher = ignore();
        matcher.add(parseGitignoreLines(contents));
        const dir = toPosixPath(dirname(relPath));
        manager.addMatcher(dir === '.' ? '' : dir, matcher);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        Logger.warn(`Failed to read .gitignore at ${absPath}: ${formatUnknownErrorMessage(error)}`);
      }
    },
    GLOB_BATCH_CONCURRENCY,
    signal,
  );
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

  addMatcher(dir: string, matcher: Ignore): void {
    this.matchers.set(dir, matcher);
  }

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

      await loadGitignoreFiles(root, gitignorePaths, manager, signal);
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
  dirent: DirentLike;
}

interface GlobEntriesOptions {
  cwd: string;
  pattern: string;
  excludePatterns: readonly string[];
  includeHidden: boolean;
  baseNameMatch: boolean;
  maxDepth?: number;
  onlyFiles: boolean;
  suppressErrors?: boolean;
  respectGitignore?: boolean;
}

type GlobMatch = string | GlobDirentLike;

interface NormalizedGlob {
  cwd: string;
  patterns: readonly string[];
  exclude: readonly string[];
  suppressErrors: boolean;
  maxDepth?: number;
  respectGitignore: boolean;
}

const GLOB_MAGIC_RE = /[*?[\]{}!]/u;
const DEFAULT_MAX_HIDDEN_DEPTH = 10;
const GLOB_BATCH_CONCURRENCY = 64;
const SEP = '/';
const DOT_CHAR_CODE = 46;
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

interface ProcessContext {
  cwd: string;
  maxDepth: number | undefined;
  seen: Set<string>;
  onlyFiles: boolean;
  suppressErrors: boolean;
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
): AsyncGenerator<GlobEntry> {
  const { cwd, suppressErrors } = plan;
  let iterable: AsyncIterable<GlobMatch>;
  try {
    iterable = fsGlob(pattern, {
      cwd,
      exclude: excludeFunc,
      withFileTypes: true,
    }) as AsyncIterable<GlobMatch>;
  } catch (error) {
    if (suppressErrors) return;
    throw error;
  }

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
}

async function* nativeGlobEntries(
  options: GlobEntriesOptions,
  gitignoreMatcher?: GitignoreManager | null,
): AsyncGenerator<GlobEntry> {
  const plan = normalizeGlobOptions(options);
  const seen = new Set<string>();

  const { cwd, maxDepth, suppressErrors } = plan;
  const { onlyFiles } = options;

  const context: ProcessContext = {
    cwd,
    maxDepth,
    seen,
    onlyFiles,
    suppressErrors,
  };

  const excludeFunc = createExcludeFilter(cwd, plan.exclude, gitignoreMatcher);

  for (const pattern of plan.patterns) {
    yield* processGlobPattern(pattern, plan, context, excludeFunc);
  }
}

export async function* globEntries(options: GlobEntriesOptions): AsyncGenerator<GlobEntry> {
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
    onlyFiles: config.onlyFiles ?? true,
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
