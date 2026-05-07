import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';

import { ErrorCode, McpError } from './errors.js';

// Inline utilities to avoid circular imports from paths.ts
const WINDOWS_PATH_SEPARATOR = '\\';
const POSIX_PATH_SEPARATOR = '/';
const IS_WINDOWS = platform() === 'win32';
const HOMEDIR = homedir();
const PATH_SEPARATOR = sep;
const HOME_PREFIX_LENGTH = 2;
const LEADING_SEPARATORS_RE = /^[/\\]+/;
const DRIVE_LETTER_REGEX = /^[A-Za-z]:/;

function toPosixPath(value: string): string {
  return value.includes(WINDOWS_PATH_SEPARATOR)
    ? value.replace(/\\/gu, POSIX_PATH_SEPARATOR)
    : value;
}

function normalizePathForMatch(input: string): string {
  return toPosixPath(normalize(input));
}

function normalizeForMatch(input: string): string {
  const normalized = normalizePathForMatch(input);
  // Always lowercase for case-insensitive denylist matching on all platforms.
  return normalized.toLowerCase();
}

function expandHome(filepath: string): string {
  if (filepath === '~') return HOMEDIR;

  // Accept both "~/" and "~\\" for cross-platform UX.
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    const rest = filepath
      .slice(HOME_PREFIX_LENGTH)
      .replace(LEADING_SEPARATORS_RE, '');
    return rest.length === 0 ? HOMEDIR : join(HOMEDIR, rest);
  }

  return filepath;
}

function normalizePath(p: string): string {
  const resolved = resolve(expandHome(p));

  if (IS_WINDOWS && DRIVE_LETTER_REGEX.test(resolved)) {
    return resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }

  return resolved;
}

function normalizeCaseForComparison(value: string): string {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

function isSamePath(left: string, right: string): boolean {
  if (left === right) return true;
  const leftResolved = normalizeCaseForComparison(resolve(left));
  const rightResolved = normalizeCaseForComparison(resolve(right));
  return leftResolved === rightResolved;
}

function stripTrailingSeparator(normalized: string): string {
  return normalized.length > 1 && normalized.endsWith(PATH_SEPARATOR)
    ? normalized.slice(0, -1)
    : normalized;
}

function isFileSystemRootPath(normalized: string, root: string): boolean {
  return isSamePath(normalized, root);
}

function normalizeAllowedDirectory(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';

  const normalized = normalizePath(trimmed);
  const { root } = parse(normalized);

  // Keep filesystem roots as-is ("/", "c:\\", "\\\\server\\share\\").
  if (isFileSystemRootPath(normalized, root)) {
    return root;
  }

  return stripTrailingSeparator(normalized);
}

function dedupePreserveOrder<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string
): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;

  const rel = relative(root, candidate);
  if (rel.length === 0) return true;
  if (rel === '..') return false;

  return !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}

function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: readonly string[]
): boolean {
  for (const allowedDir of allowedDirs) {
    if (isPathInsideDirectory(allowedDir, normalizedPath)) return true;
  }

  return false;
}

interface CompiledPattern {
  globs: readonly string[];
  matchesPath: boolean;
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

const WINDOWS_ABSOLUTE_RE = /^[a-z]:\//iu;

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  const globs = new Set<string>([normalizedPattern]);
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_RE.test(normalizedPattern);

  if (!normalizedPattern.startsWith('**/') && !isWindowsAbsolute) {
    const withoutRoot = normalizedPattern.replace(/^\/+/u, '');
    if (withoutRoot.length > 0) {
      globs.add(`**/${withoutRoot}`);
    }
  }

  return [...globs];
}

function compilePatterns(patterns: readonly string[]): CompiledPattern[] {
  const unique = new Set<string>();
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
  }

  const compiled: CompiledPattern[] = [];
  for (const pattern of unique) {
    const normalized = normalizeForMatch(pattern);
    const matchesPath = normalized.includes('/');
    compiled.push({
      globs: matchesPath ? compilePatternGlobs(normalized) : [normalized],
      matchesPath,
    });
  }
  return compiled;
}

function toPatternSet(
  patterns: readonly CompiledPattern[]
): CompiledPatternSet {
  const pathGlobs = new Set<string>();
  const nameGlobs = new Set<string>();

  for (const pattern of patterns) {
    const target = pattern.matchesPath ? pathGlobs : nameGlobs;
    for (const glob of pattern.globs) {
      target.add(glob);
    }
  }

  return {
    pathGlobs: [...pathGlobs],
    nameGlobs: [...nameGlobs],
  };
}

function matchesAnyGlobs(
  globs: readonly string[],
  candidates: readonly string[]
): boolean {
  if (globs.length === 0 || candidates.length === 0) return false;

  for (const candidate of candidates) {
    for (const glob of globs) {
      if (posix.matchesGlob(candidate, glob)) return true;
    }
  }

  return false;
}

export interface AllowedDirectoriesState {
  primary: string[];
  expanded: string[];
}

export interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

let defaultPathGuard: PathGuard | undefined;

export function setDefaultPathGuard(guard: PathGuard): void {
  defaultPathGuard = guard;
}

export function getDefaultPathGuard(): PathGuard {
  if (!defaultPathGuard) {
    throw new Error(
      'PathGuard not initialized. Call setDefaultPathGuard first.'
    );
  }
  return defaultPathGuard;
}

export class PathGuard {
  private allowedDirectoriesState: AllowedDirectoriesState | undefined;
  private denyPatterns: CompiledPatternSet;

  constructor(sensitivePatterns: readonly string[]) {
    this.denyPatterns = toPatternSet(compilePatterns(sensitivePatterns));
  }

  initialize(state: AllowedDirectoriesState): void {
    // Normalize all allowed directories to ensure consistency
    const normalized: string[] = [];
    for (const dir of state.expanded) {
      const entry = normalizeAllowedDirectory(dir);
      if (entry.length > 0) {
        normalized.push(entry);
      }
    }

    this.allowedDirectoriesState = {
      primary: [...dedupePreserveOrder(state.primary)],
      expanded: [...dedupePreserveOrder(normalized)],
    };
  }

  getAllowedDirectories(): string[] {
    if (!this.allowedDirectoriesState) {
      return [];
    }
    return [...this.allowedDirectoriesState.expanded];
  }

  isSensitive(filePath: string): boolean {
    if (
      this.denyPatterns.pathGlobs.length === 0 &&
      this.denyPatterns.nameGlobs.length === 0
    ) {
      return false;
    }

    const normalizedPath = normalizeForMatch(filePath);
    const pathCandidates = [normalizedPath];
    const nameCandidates = [posix.basename(normalizedPath)];

    return (
      matchesAnyGlobs(this.denyPatterns.pathGlobs, pathCandidates) ||
      matchesAnyGlobs(this.denyPatterns.nameGlobs, nameCandidates)
    );
  }

  isSafeGlob(pattern: string): boolean {
    // Empty pattern is not safe
    if (!pattern || pattern.trim().length === 0) {
      return false;
    }

    // Absolute paths are not safe
    if (isAbsolute(pattern)) {
      return false;
    }

    // Patterns with .. traversal are not safe
    if (pattern.includes('..')) {
      return false;
    }

    return true;
  }

  assertSafeGlob(
    pattern: string,
    message = 'Invalid glob or unsafe path (absolute/.. forbidden)'
  ): void {
    if (!this.isSafeGlob(pattern)) {
      throw new McpError(ErrorCode.INVALID_PATTERN, message);
    }
  }

  async validateExistingPath(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);
    return details.resolvedPath;
  }

  async validateExistingPathDetailed(
    requestedPath: string
  ): Promise<ValidatedPathDetails> {
    if (!this.allowedDirectoriesState) {
      throw new Error('PathGuard not initialized. Call initialize() first.');
    }

    // Normalize and validate the path
    const normalizedRequested = normalizePath(requestedPath);
    const allowedDirs = this.allowedDirectoriesState.expanded;

    // Check if within allowed directories
    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      throw new Error(`Path outside allowed directories: ${requestedPath}`);
    }

    // Resolve the real path
    let realPath: string;
    try {
      realPath = await realpath(normalizedRequested);
    } catch (error) {
      throw new Error(`Cannot access path: ${requestedPath}`, { cause: error });
    }

    const normalizedReal = normalizePath(realPath);

    // Check if the resolved path is still within allowed directories
    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      throw new Error(
        `Resolved path outside allowed directories: ${requestedPath}`
      );
    }

    return {
      requestedPath: normalizedRequested,
      resolvedPath: normalizedReal,
      isSymlink: !isSamePath(normalizedRequested, normalizedReal),
    };
  }

  async validateExistingDirectory(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);

    // Check if it's a directory
    try {
      const stats = await stat(details.resolvedPath);
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${requestedPath}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Not a directory')) {
        throw error;
      }
      throw new Error(`Cannot access directory: ${requestedPath}`, {
        cause: error,
      });
    }

    return details.resolvedPath;
  }

  async validatePathForWrite(requestedPath: string): Promise<string> {
    if (!this.allowedDirectoriesState) {
      throw new Error('PathGuard not initialized. Call initialize() first.');
    }

    // Check if path is sensitive
    const normalizedRequested = normalizePath(requestedPath);
    if (
      this.isSensitive(requestedPath) ||
      this.isSensitive(normalizedRequested)
    ) {
      throw new Error(`Sensitive file blocked by policy: ${requestedPath}`);
    }

    const allowedDirs = this.allowedDirectoriesState.expanded;

    // Check if within allowed directories
    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      throw new Error(`Path outside allowed directories: ${requestedPath}`);
    }

    // Resolve the nearest existing real path
    let current = normalizedRequested;
    let realPath: string;

    for (;;) {
      try {
        realPath = await realpath(current);
        break;
      } catch (_error) {
        const parent = dirname(current);
        if (parent === current) {
          throw new Error(`Cannot resolve path: ${requestedPath}`, {
            cause: _error,
          });
        }
        current = parent;
      }
    }

    const normalizedReal = normalizePath(realPath);

    // Check if the resolved path is still within allowed directories
    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      throw new Error(
        `Resolved path outside allowed directories: ${requestedPath}`
      );
    }

    return normalizedRequested;
  }
}
