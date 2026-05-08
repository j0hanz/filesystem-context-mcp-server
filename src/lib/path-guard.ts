import type { Root } from '@modelcontextprotocol/server';

import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  resolve,
  sep,
  win32,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNotAborted, withAbort } from './abort.js';
import { SENSITIVE_FILE_DENYLIST } from './constants.js';
import { ErrorCode, isAbortError, McpError } from './errors.js';

// Path utility primitives. Owned by path-guard.ts to avoid a circular
// dependency with paths.ts (which depends on PathGuard). paths.ts re-exports
// the public ones.
const WINDOWS_PATH_SEPARATOR = '\\';
const POSIX_PATH_SEPARATOR = '/';
const IS_WINDOWS = platform() === 'win32';
const HOMEDIR = homedir();
const PATH_SEPARATOR = sep;
const HOME_PREFIX_LENGTH = 2;
const LEADING_SEPARATORS_RE = /^[/\\]+/;
const DRIVE_LETTER_REGEX = /^[A-Za-z]:/;

export function toPosixPath(value: string): string {
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

export function normalizePath(p: string): string {
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

  if (!candidate.startsWith(root)) return false;
  const rootEndsWithSep =
    root.endsWith(POSIX_PATH_SEPARATOR) ||
    root.endsWith(WINDOWS_PATH_SEPARATOR);
  if (rootEndsWithSep) return true;

  const nextChar = candidate[root.length];
  return (
    nextChar === POSIX_PATH_SEPARATOR || nextChar === WINDOWS_PATH_SEPARATOR
  );
}

export function isPathWithinDirectories(
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

interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

// ---------------------------------------------------------------------------
// Resolver pipeline (moved from paths.ts)
// ---------------------------------------------------------------------------

function normalizeAllowedDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const entry = normalizeAllowedDirectory(dir);
    if (entry.length > 0) {
      normalized.push(entry);
    }
  }
  return dedupePreserveOrder(normalized);
}

async function resolveRealPath(
  normalized: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalized), signal);
    return normalizeAllowedDirectory(realPath);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        ('code' in error &&
          (error as NodeJS.ErrnoException).code === 'ERR_ABORTED'))
    ) {
      throw error;
    }
    return null;
  }
}

async function expandAllowedDirectories(
  primaryDirs: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  const realPaths = await Promise.all(
    primaryDirs.map((dir) => resolveRealPath(dir, signal))
  );

  const expanded: string[] = [];
  for (let i = 0; i < primaryDirs.length; i++) {
    const primary = primaryDirs[i];
    if (!primary) continue;

    expanded.push(primary);

    const real = realPaths[i];
    if (real && !isSamePath(real, primary)) {
      expanded.push(real);
    }
  }

  return dedupePreserveOrder(expanded);
}

export async function resolveAllowedDirectoriesState(
  dirs: readonly string[],
  signal?: AbortSignal
): Promise<AllowedDirectoriesState> {
  const primary = normalizeAllowedDirectories(dirs);
  const expanded = await expandAllowedDirectories(primary, signal);
  return { primary, expanded };
}

// ---------------------------------------------------------------------------
// Windows helpers (moved from paths.ts)
// ---------------------------------------------------------------------------

function getReservedDeviceName(segment: string): string | undefined {
  const CHAR_CODE_SPACE = 32;
  const CHAR_CODE_DOT = 46;
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c === CHAR_CODE_SPACE || c === CHAR_CODE_DOT) end--;
    else break;
  }
  const trimmed = segment.slice(0, end);
  const streamIdx = trimmed.indexOf(':');
  const withoutStream =
    streamIdx !== -1 ? trimmed.slice(0, streamIdx) : trimmed;
  const dotIdx = withoutStream.indexOf('.');
  const baseName = (
    dotIdx !== -1 ? withoutStream.slice(0, dotIdx) : withoutStream
  ).toUpperCase();

  const RESERVED_DEVICE_NAMES = new Set([
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]);
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

export function getReservedDeviceNameForPath(
  requestedPath: string
): string | undefined {
  if (!IS_WINDOWS) return undefined;
  const segments = requestedPath.split(/[\\/]/u);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) return reserved;
  }
  return undefined;
}

export function isWindowsDriveRelativePath(requestedPath: string): boolean {
  if (!IS_WINDOWS) return false;
  const WINDOWS_DRIVE_REL_REGEX = /^[A-Za-z]:$/u;
  const parsed = win32.parse(requestedPath);
  if (!WINDOWS_DRIVE_REL_REGEX.test(parsed.root)) return false;
  return !win32.isAbsolute(requestedPath);
}

/**
 * Pure glob-syntax safety check that does not require an initialized PathGuard.
 * Returns false for absolute paths and patterns containing traversal sequences (`..'`).
 * This is the subset of safety enforcement suitable for schema-level validation.
 * Operational path enforcement (allowed-root containment, symlink resolution) is
 * handled by PathGuard.assertSafeGlob and the validateExistingPath family.
 */
export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) return false;
  if (isAbsolute(pattern)) return false;
  if (pattern.includes('..')) return false;
  return true;
}

export class PathGuard {
  private allowedDirectoriesState: AllowedDirectoriesState | undefined;
  private denyPatterns: CompiledPatternSet;

  constructor(sensitivePatterns: readonly string[]) {
    this.denyPatterns = toPatternSet(compilePatterns(sensitivePatterns));
  }

  /**
   * Resolve `dirs`, construct an initialized PathGuard, and return it.
   * Reads `SENSITIVE_FILE_DENYLIST` (which already incorporates
   * `FS_CONTEXT_ALLOW_SENSITIVE`) from constants.
   */
  static async fromAllowedDirectories(
    dirs: readonly string[],
    signal?: AbortSignal
  ): Promise<PathGuard> {
    const state = await resolveAllowedDirectoriesState(dirs, signal);
    const guard = new PathGuard(SENSITIVE_FILE_DENYLIST);
    guard.initialize(state);
    return guard;
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
      throw new McpError(
        ErrorCode.UNKNOWN,
        'PathGuard not initialized. Call initialize() first.',
        requestedPath
      );
    }

    // Normalize and validate the path
    const normalizedRequested = normalizePath(requestedPath);
    const allowedDirs = this.allowedDirectoriesState.expanded;

    // Check if within allowed directories
    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      const hint =
        allowedDirs.length > 0
          ? `Allowed: ${allowedDirs.join(', ')}`
          : 'No allowed directories configured.';
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${hint}`,
        requestedPath
      );
    }

    // Resolve the real path
    let realPath: string;
    try {
      realPath = await realpath(normalizedRequested);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        throw new McpError(
          ErrorCode.NOT_FOUND,
          'Path not found',
          requestedPath,
          { originalError: error.message },
          error
        );
      }
      throw new McpError(
        ErrorCode.UNKNOWN,
        'Cannot access path',
        requestedPath,
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error : undefined
      );
    }

    const normalizedReal = normalizePath(realPath);

    // Check if the resolved path is still within allowed directories
    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      const hint =
        allowedDirs.length > 0
          ? `Allowed: ${allowedDirs.join(', ')}`
          : 'No allowed directories configured.';
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${hint}`,
        requestedPath,
        { resolvedPath: realPath, normalizedResolvedPath: normalizedReal }
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

    let stats;
    try {
      stats = await stat(details.resolvedPath);
    } catch (error) {
      throw new McpError(
        ErrorCode.UNKNOWN,
        'Cannot access directory',
        requestedPath,
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error : undefined
      );
    }

    if (!stats.isDirectory()) {
      throw new McpError(
        ErrorCode.NOT_DIRECTORY,
        'Not a directory',
        requestedPath
      );
    }

    return details.resolvedPath;
  }

  /**
   * Returns `pathValue` when non-empty; otherwise returns the single allowed
   * root. Throws when the path is ambiguous (multiple roots) or no roots.
   */
  resolvePathOrRoot(pathValue: string | undefined): string {
    if (pathValue && pathValue.trim().length > 0) return pathValue;
    const roots = this.getAllowedDirectories();
    if (roots.length === 0) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'No roots configured. Use roots tool, --allow-cwd, or MCP Roots protocol.'
      );
    }
    if (roots.length > 1) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'Multiple roots configured. Provide an explicit path.'
      );
    }
    const root = roots[0];
    if (!root) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Workspace root is unexpectedly undefined'
      );
    }
    return root;
  }

  /**
   * True when `normalizedPath` equals one of the primary allowed roots exactly.
   */
  isAllowedRoot(normalizedPath: string): boolean {
    const target = IS_WINDOWS ? normalizedPath.toLowerCase() : normalizedPath;
    for (const dir of this.getAllowedDirectories()) {
      const d = IS_WINDOWS ? dir.toLowerCase() : dir;
      if (target === d) return true;
    }
    return false;
  }

  /**
   * Throws `ACCESS_DENIED` if `requestedPath` matches the sensitive-file denylist.
   */
  assertAllowedFileAccess(requestedPath: string): void {
    if (this.isSensitive(requestedPath)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
        requestedPath
      );
    }
  }

  async validatePathForWrite(requestedPath: string): Promise<string> {
    if (!this.allowedDirectoriesState) {
      throw new McpError(
        ErrorCode.UNKNOWN,
        'PathGuard not initialized. Call initialize() first.',
        requestedPath
      );
    }

    const normalizedRequested = normalizePath(requestedPath);
    if (
      this.isSensitive(requestedPath) ||
      this.isSensitive(normalizedRequested)
    ) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
        requestedPath
      );
    }

    const allowedDirs = this.allowedDirectoriesState.expanded;
    const accessDeniedHint =
      allowedDirs.length > 0
        ? `Allowed: ${allowedDirs.join(', ')}`
        : 'No allowed directories configured.';

    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath
      );
    }

    // Resolve the nearest existing real path
    let current = normalizedRequested;
    let realPath: string;

    for (;;) {
      try {
        realPath = await realpath(current);
        break;
      } catch (error) {
        const parent = dirname(current);
        if (parent === current) {
          throw new McpError(
            ErrorCode.UNKNOWN,
            'Cannot resolve path',
            requestedPath,
            {
              originalError:
                error instanceof Error ? error.message : String(error),
            },
            error instanceof Error ? error : undefined
          );
        }
        current = parent;
      }
    }

    const normalizedReal = normalizePath(realPath);

    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
        { resolvedPath: realPath, normalizedResolvedPath: normalizedReal }
      );
    }

    return normalizedRequested;
  }
}

// ─── Root directory resolution (used by RootsManager) ───────────────────────

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
}

async function maybeAddRealPath(
  normalizedPath: string,
  validDirs: string[],
  signal?: AbortSignal
): Promise<void> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedPath), signal);
    const normalizedReal = normalizePath(realPath);
    if (!isSamePath(normalizedReal, normalizedPath)) {
      validDirs.push(normalizedReal);
    }
  } catch (error) {
    rethrowIfAborted(error);
  }
}

async function resolveRootDirectory(
  root: Root,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const dirPath = fileURLToPath(root.uri);
    const normalizedPath = normalizePath(dirPath);
    assertNotAborted(signal);
    const stats = await withAbort(stat(normalizedPath), signal);
    if (!stats.isDirectory()) return null;
    return normalizedPath;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}

export async function getValidRootDirectories(
  roots: Root[],
  signal?: AbortSignal
): Promise<string[]> {
  const fileRoots = roots.filter(isFileRoot);
  if (fileRoots.length === 0) return [];

  const resolvedResults = await Promise.all(
    fileRoots.map((root) => resolveRootDirectory(root, signal))
  );
  const validPaths = resolvedResults.filter((p): p is string => p !== null);
  if (validPaths.length === 0) return [];

  const realExpansions = await Promise.all(
    validPaths.map(async (normalizedPath) => {
      const extra: string[] = [];
      await maybeAddRealPath(normalizedPath, extra, signal);
      return extra[0] ?? null;
    })
  );

  const validDirs: string[] = [];
  let i = 0;
  for (const p of validPaths) {
    validDirs.push(p);
    const expanded = realExpansions[i];
    if (expanded !== null && expanded !== undefined) {
      validDirs.push(expanded);
    }
    i++;
  }
  return validDirs;
}
