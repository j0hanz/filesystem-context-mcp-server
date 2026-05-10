import type { McpServer, Root } from '@modelcontextprotocol/server';

import type { Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod/v4';

import { assertNotAborted, withAbort } from './concurrency.js';
import { ErrorCode, isAbortError, isNodeError, McpError } from './errors.js';
import { SENSITIVE_FILE_DENYLIST } from './util.js';

// Path utility primitives. Owned by path-guard.ts to avoid a circular
// dependency with paths.ts (which depends on PathGuard). paths.ts re-exports
// the public ones.
const WINDOWS_PATH_SEPARATOR = '\\';
const POSIX_PATH_SEPARATOR = '/';
const IS_WINDOWS = platform() === 'win32';
const HOMEDIR = homedir();
const PATH_SEPARATOR = sep;

const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_COLON = 58;
const CHAR_TILDE = 126;
const CHAR_SPACE = 32;
const CHAR_DOT = 46;

function isSlash(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function toPosixPath(value: string): string {
  return value.includes(WINDOWS_PATH_SEPARATOR)
    ? value.replaceAll(WINDOWS_PATH_SEPARATOR, POSIX_PATH_SEPARATOR)
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
  if (
    filepath.length > 1 &&
    filepath.charCodeAt(0) === CHAR_TILDE &&
    isSlash(filepath.charCodeAt(1))
  ) {
    let startIdx = 2;
    while (startIdx < filepath.length && isSlash(filepath.charCodeAt(startIdx))) {
      startIdx++;
    }
    const rest = filepath.slice(startIdx);
    return rest.length === 0 ? HOMEDIR : join(HOMEDIR, rest);
  }

  return filepath;
}

export function normalizePath(p: string): string {
  const resolved = resolve(expandHome(p));

  if (IS_WINDOWS && resolved.length >= 2 && resolved.charCodeAt(1) === CHAR_COLON) {
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

function isPathInsideDirectory(normalizedDirectory: string, normalizedCandidate: string): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;
  if (!candidate.startsWith(root)) return false;

  if (isSlash(root.charCodeAt(root.length - 1))) return true;
  return isSlash(candidate.charCodeAt(root.length));
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: readonly string[],
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

function isWindowsAbsolutePosixPath(normalizedPattern: string): boolean {
  return (
    normalizedPattern.length >= 3 &&
    normalizedPattern.charCodeAt(1) === CHAR_COLON &&
    normalizedPattern.charCodeAt(2) === CHAR_FORWARD_SLASH &&
    isAlpha(normalizedPattern.charCodeAt(0))
  );
}

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  const globs = new Set<string>([normalizedPattern]);

  if (!normalizedPattern.startsWith('**/') && !isWindowsAbsolutePosixPath(normalizedPattern)) {
    let startIdx = 0;
    while (
      startIdx < normalizedPattern.length &&
      normalizedPattern.charCodeAt(startIdx) === CHAR_FORWARD_SLASH
    ) {
      startIdx++;
    }
    const withoutRoot = normalizedPattern.slice(startIdx);
    if (withoutRoot.length > 0) {
      globs.add(`**/${withoutRoot}`);
    }
  }

  return Array.from(globs);
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

function toPatternSet(patterns: readonly CompiledPattern[]): CompiledPatternSet {
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

function matchesAnyGlob(globs: readonly string[], candidate: string): boolean {
  if (globs.length === 0) return false;

  for (const glob of globs) {
    if (posix.matchesGlob(candidate, glob)) return true;
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

async function resolveRealPath(normalized: string, signal?: AbortSignal): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalized), signal);
    return normalizeAllowedDirectory(realPath);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        ('code' in error && (error as NodeJS.ErrnoException).code === 'ERR_ABORTED'))
    ) {
      throw error;
    }
    return null;
  }
}

async function expandAllowedDirectories(
  primaryDirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const realPaths = await Promise.all(primaryDirs.map((dir) => resolveRealPath(dir, signal)));

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
  signal?: AbortSignal,
): Promise<AllowedDirectoriesState> {
  const primary = normalizeAllowedDirectories(dirs);
  const expanded = await expandAllowedDirectories(primary, signal);
  return { primary, expanded };
}

// ---------------------------------------------------------------------------
// Windows helpers (moved from paths.ts)
// ---------------------------------------------------------------------------

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

function getReservedDeviceName(segment: string): string | undefined {
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c === CHAR_SPACE || c === CHAR_DOT) end--;
    else break;
  }
  const trimmed = segment.slice(0, end);
  const streamIdx = trimmed.indexOf(':');
  const withoutStream = streamIdx !== -1 ? trimmed.slice(0, streamIdx) : trimmed;
  const dotIdx = withoutStream.indexOf('.');
  const baseName = (dotIdx !== -1 ? withoutStream.slice(0, dotIdx) : withoutStream).toUpperCase();

  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

export function getReservedDeviceNameForPath(requestedPath: string): string | undefined {
  if (!IS_WINDOWS) return undefined;
  const segments = requestedPath.split(/[\\/]/u);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) return reserved;
  }
  return undefined;
}

export function isWindowsDriveRelativePath(requestedPath: string): boolean {
  if (!IS_WINDOWS || requestedPath.length < 2) return false;
  if (requestedPath.charCodeAt(1) !== CHAR_COLON) return false;
  if (!isAlpha(requestedPath.charCodeAt(0))) return false;

  if (requestedPath.length === 2) return true;
  return !isSlash(requestedPath.charCodeAt(2));
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
    signal?: AbortSignal,
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
    if (this.denyPatterns.pathGlobs.length === 0 && this.denyPatterns.nameGlobs.length === 0) {
      return false;
    }

    const normalizedPath = normalizeForMatch(filePath);

    return (
      matchesAnyGlob(this.denyPatterns.pathGlobs, normalizedPath) ||
      matchesAnyGlob(this.denyPatterns.nameGlobs, posix.basename(normalizedPath))
    );
  }

  isSafeGlob(pattern: string): boolean {
    return isSafeGlobSyntax(pattern);
  }

  assertSafeGlob(
    pattern: string,
    message = 'Invalid glob or unsafe path (absolute/.. forbidden)',
  ): void {
    if (!this.isSafeGlob(pattern)) {
      throw new McpError(ErrorCode.INVALID_PATTERN, message);
    }
  }

  async validateExistingPath(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);
    return details.resolvedPath;
  }

  private validateAccess(requestedPath: string): {
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  } {
    if (!this.allowedDirectoriesState) {
      throw new McpError(
        ErrorCode.UNKNOWN,
        'PathGuard not initialized. Call initialize() first.',
        requestedPath,
      );
    }

    const normalizedRequested = normalizePath(requestedPath);
    const allowedDirs = this.allowedDirectoriesState.expanded;

    const accessDeniedHint =
      allowedDirs.length > 0
        ? `Allowed: ${allowedDirs.join(', ')}`
        : 'No allowed directories configured.';

    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
      );
    }

    return { normalizedRequested, allowedDirs, accessDeniedHint };
  }

  async validateExistingPathDetailed(requestedPath: string): Promise<ValidatedPathDetails> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccess(requestedPath);

    // Resolve the real path
    let realPath: string;
    try {
      realPath = await realpath(normalizedRequested);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new McpError(
          ErrorCode.NOT_FOUND,
          'Path not found',
          requestedPath,
          { originalError: error.message },
          error,
        );
      }
      throw new McpError(
        ErrorCode.UNKNOWN,
        'Cannot access path',
        requestedPath,
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error : undefined,
      );
    }

    const normalizedReal = normalizePath(realPath);

    // Check if the resolved path is still within allowed directories
    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
        { resolvedPath: realPath, normalizedResolvedPath: normalizedReal },
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

    let stats: Stats;
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
        error instanceof Error ? error : undefined,
      );
    }

    if (!stats.isDirectory()) {
      throw new McpError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requestedPath);
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
        'No roots configured. Use roots tool, --allow-cwd, or MCP Roots protocol.',
      );
    }
    if (roots.length > 1) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'Multiple roots configured. Provide an explicit path.',
      );
    }
    const root = roots[0];
    if (!root) {
      throw new McpError(ErrorCode.ACCESS_DENIED, 'Workspace root is unexpectedly undefined');
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
        requestedPath,
      );
    }
  }

  private async findNearestExistingAncestor(
    requestedPath: string,
    currentPath: string,
  ): Promise<string> {
    let current = currentPath;
    for (;;) {
      try {
        return await realpath(current);
      } catch (error) {
        const parent = dirname(current);
        if (parent === current) {
          throw new McpError(
            ErrorCode.UNKNOWN,
            'Cannot resolve path',
            requestedPath,
            { originalError: error instanceof Error ? error.message : String(error) },
            error instanceof Error ? error : undefined,
          );
        }
        current = parent;
      }
    }
  }

  async validatePathForWrite(requestedPath: string): Promise<string> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccess(requestedPath);

    if (this.isSensitive(requestedPath) || this.isSensitive(normalizedRequested)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }

    // Resolve the nearest existing real path
    const realPath = await this.findNearestExistingAncestor(requestedPath, normalizedRequested);
    const normalizedReal = normalizePath(realPath);

    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
        { resolvedPath: realPath, normalizedResolvedPath: normalizedReal },
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

async function resolveRealPathIfExists(
  normalizedPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedPath), signal);
    const normalizedReal = normalizePath(realPath);
    return isSamePath(normalizedReal, normalizedPath) ? null : normalizedReal;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}

async function resolveRootDirectory(root: Root, signal?: AbortSignal): Promise<string | null> {
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
  signal?: AbortSignal,
): Promise<string[]> {
  const fileRoots = roots.filter(isFileRoot);
  if (fileRoots.length === 0) return [];

  const resolvedResults = await Promise.all(
    fileRoots.map((root) => resolveRootDirectory(root, signal)),
  );
  const validPaths = resolvedResults.filter((p): p is string => p !== null);
  if (validPaths.length === 0) return [];

  const realExpansions = await Promise.all(
    validPaths.map((normalizedPath) => resolveRealPathIfExists(normalizedPath, signal)),
  );

  const validDirs: string[] = [];
  for (let i = 0; i < validPaths.length; i++) {
    const validPath = validPaths[i];
    if (validPath !== undefined) {
      validDirs.push(validPath);
    }
    const expanded = realExpansions[i];
    if (expanded) validDirs.push(expanded);
  }
  return validDirs;
}

// path-guard is in this file, no import needed

const MAX_COMPLETION_ITEMS = 100;
const COMPLETION_RATE_LIMIT_MS = 100;
const MAX_COMPLETION_CACHE_KEYS = 128;

interface CacheEntry {
  ms: number;
  result: string[];
}

interface CompletionState {
  cache: Map<string, CacheEntry>;
}

const completionState = new WeakMap<McpServer, CompletionState>();

function getCompletionState(server: McpServer): CompletionState {
  let state = completionState.get(server);
  if (state === undefined) {
    state = { cache: new Map() };
    completionState.set(server, state);
  }
  return state;
}

function setCacheValue(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_COMPLETION_CACHE_KEYS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function buildCacheKey(
  argumentName: string,
  value: string,
  contextArguments?: Record<string, string>,
): string {
  const base = `${argumentName.toLowerCase()}:${value}`;
  if (!contextArguments) return base;
  const keys = Object.keys(contextArguments);
  if (keys.length === 0) return base;
  return `${base}:${JSON.stringify(contextArguments)}`;
}

const DESTINATION_CONTEXT_KEYS = ['source', 'path', 'cwd', 'root'] as const;
const PRIMARY_PATH_CONTEXT_KEYS = ['path', 'cwd', 'root'] as const;
const DEFAULT_CONTEXT_KEYS = ['path', 'source', 'cwd', 'root'] as const;

function chooseContextKeys(argumentName: string): readonly string[] {
  const normalized = argumentName.toLowerCase();
  if (normalized === 'destination') return DESTINATION_CONTEXT_KEYS;
  if (
    normalized === 'path' ||
    normalized === 'source' ||
    normalized === 'original' ||
    normalized === 'modified' ||
    normalized === 'file'
  ) {
    return PRIMARY_PATH_CONTEXT_KEYS;
  }
  return DEFAULT_CONTEXT_KEYS;
}

function hasTrailingSeparator(value: string): boolean {
  return value.length > 0 && isSlash(value.charCodeAt(value.length - 1));
}

function resolveFromBase(
  base: string,
  rawValue: string,
  trailingSeparator: boolean,
): { searchDir: string; prefix: string } {
  const normalizedValue = normalizePath(resolve(base, rawValue));
  if (trailingSeparator) return { searchDir: normalizedValue, prefix: '' };
  return {
    searchDir: dirname(normalizedValue),
    prefix: basename(normalizedValue),
  };
}

function parseNamedRootInput(value: string): { rootName: string; remainder: string } | undefined {
  const normalizedInput = toPosixPath(value);
  if (!normalizedInput) return undefined;
  const slashIndex = normalizedInput.indexOf('/');
  if (slashIndex === -1) return { rootName: normalizedInput, remainder: '' };
  const rootName = normalizedInput.slice(0, slashIndex);
  if (!rootName) return undefined;
  return { rootName, remainder: normalizedInput.slice(slashIndex + 1) };
}

function findAllowedRootByName(rootName: string, allowed: readonly string[]): string | undefined {
  const normalizedRootName = rootName.toLowerCase();
  return allowed.find((candidate) => basename(candidate).toLowerCase() === normalizedRootName);
}

function resolveNamedRootPath(value: string, allowed: string[]): string | undefined {
  const parsed = parseNamedRootInput(value);
  if (!parsed) return undefined;
  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;
  return normalizePath(resolve(root, parsed.remainder));
}

function resolveNamedRootContext(
  currentValue: string,
  allowed: string[],
): { searchDir: string; prefix: string } | undefined {
  const parsed = parseNamedRootInput(currentValue);
  if (!parsed) return undefined;
  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;
  const trailingSeparator = hasTrailingSeparator(currentValue);
  return resolveFromBase(root, parsed.remainder, trailingSeparator);
}

async function isAllowedCompletionDirectory(path: string, allowed: string[]): Promise<boolean> {
  if (!isPathWithinDirectories(path, allowed)) return false;
  try {
    const [stats, resolvedRealPath] = await Promise.all([stat(path), realpath(path)]);
    if (!stats.isDirectory()) return false;
    return isPathWithinDirectories(normalizePath(resolvedRealPath), allowed);
  } catch {
    return false;
  }
}

async function toAllowedContextDirectory(
  resolved: string,
  allowed: string[],
): Promise<string | undefined> {
  const parent = dirname(resolved);
  const [resolvedOk, parentOk] = await Promise.all([
    isAllowedCompletionDirectory(resolved, allowed),
    isAllowedCompletionDirectory(parent, allowed),
  ]);
  if (resolvedOk) return resolved;
  if (parentOk) return parent;
  return undefined;
}

function resolveContextCandidatePath(candidate: string, allowed: string[]): string | undefined {
  if (isAbsolute(candidate)) return normalizePath(candidate);
  if (allowed.length === 1) {
    const base = allowed[0];
    if (!base) return undefined;
    return normalizePath(resolve(base, candidate));
  }
  return resolveNamedRootPath(candidate, allowed);
}

async function resolveContextBaseDirectory(
  argumentName: string,
  contextArguments: Record<string, string> | undefined,
  allowed: string[],
): Promise<string | undefined> {
  if (!contextArguments || Object.keys(contextArguments).length === 0) {
    return undefined;
  }
  const keys = chooseContextKeys(argumentName);
  for (const key of keys) {
    const candidate = contextArguments[key];
    if (!candidate || candidate.trim().length === 0) continue;
    const resolved = resolveContextCandidatePath(candidate, allowed);
    if (!resolved) continue;
    const baseDirectory = await toAllowedContextDirectory(resolved, allowed);
    if (baseDirectory) return baseDirectory;
  }
  return undefined;
}

function withDirectorySeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`;
}

function collectAllowedRoots(
  allowed: readonly string[],
  predicate: (root: string) => boolean,
): string[] {
  const matches: string[] = [];
  for (const root of allowed) {
    if (predicate(root)) matches.push(withDirectorySeparator(root));
  }
  return matches;
}

function getRootPrefix(currentValue: string): string {
  const normalizedInput = toPosixPath(currentValue);
  const slashIndex = normalizedInput.indexOf('/');
  return (slashIndex === -1 ? normalizedInput : normalizedInput.slice(0, slashIndex)).toLowerCase();
}

function findRootPrefixMatches(currentValue: string, allowed: string[]): string[] {
  const rootPrefix = getRootPrefix(currentValue);
  if (!rootPrefix) return collectAllowedRoots(allowed, () => true);
  return collectAllowedRoots(allowed, (root) =>
    basename(root).toLowerCase().startsWith(rootPrefix),
  );
}

function findMatchingRoots(searchDir: string, prefix: string, allowed: string[]): string[] {
  const lowerPrefix = prefix.toLowerCase();
  const normalizedSearchDir = normalizePath(searchDir);
  return collectAllowedRoots(allowed, (root) => {
    const rootDir = dirname(root);
    if (normalizePath(rootDir) !== normalizedSearchDir) return false;
    return basename(root).toLowerCase().startsWith(lowerPrefix);
  });
}

function sortCompletionMatches(matches: string[]): void {
  const sepCode = sep.charCodeAt(0);
  matches.sort((left, right) => {
    const leftIsDir = left.charCodeAt(left.length - 1) === sepCode;
    const rightIsDir = right.charCodeAt(right.length - 1) === sepCode;
    if (leftIsDir && !rightIsDir) return -1;
    if (!leftIsDir && rightIsDir) return 1;
    return left.localeCompare(right);
  });
}

function mergeCompletionMatches(...matchGroups: readonly (readonly string[])[]): string[] {
  const uniqueMatches = new Set<string>();
  for (const group of matchGroups) {
    for (const match of group) uniqueMatches.add(match);
  }
  const merged = Array.from(uniqueMatches);
  sortCompletionMatches(merged);
  return merged;
}

async function findMatchesInDirectory(
  searchDir: string,
  prefix: string,
  allowed: string[],
): Promise<string[]> {
  const matches: string[] = [];
  if (!(await isAllowedCompletionDirectory(searchDir, allowed))) return matches;
  try {
    const entries = await readdir(searchDir, { withFileTypes: true });
    const dirSep = searchDir.endsWith(sep) ? '' : sep;

    if (prefix === '') {
      for (const entry of entries) {
        const fullPath = `${searchDir}${dirSep}${entry.name}`;
        matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
      }
    } else {
      const lowerPrefix = prefix.toLowerCase();
      for (const entry of entries) {
        if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
          const fullPath = `${searchDir}${dirSep}${entry.name}`;
          matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
        }
      }
    }
  } catch {
    // Access denied or not found — skip.
  }
  return matches;
}

function getSearchContext(
  currentValue: string,
  allowed: string[],
  contextBase?: string,
): { searchDir: string; prefix: string } | undefined {
  const trailingSeparator = hasTrailingSeparator(currentValue);
  if (isAbsolute(currentValue)) {
    return resolveFromBase(parse(currentValue).root || sep, currentValue, trailingSeparator);
  }
  const namedRootContext = resolveNamedRootContext(currentValue, allowed);
  if (namedRootContext) return namedRootContext;
  if (contextBase) {
    if (currentValue.length === 0) return { searchDir: contextBase, prefix: '' };
    return resolveFromBase(contextBase, currentValue, trailingSeparator);
  }
  if (allowed.length === 1) {
    const base = allowed[0];
    if (base) return resolveFromBase(base, currentValue, trailingSeparator);
  }
  return undefined;
}

export interface CompletePathOptions {
  /** McpServer instance for WeakMap cache key. Cache disabled when absent. */
  server?: McpServer;
  /** PathGuard for the current session (provides allowed directories). */
  pathGuard: PathGuard;
  /** Argument name — drives context-key selection (e.g. 'path', 'modified'). */
  argumentName?: string;
  /** Sibling argument values from the completion ctx.arguments field. */
  contextArguments?: Record<string, string>;
}

/**
 * Returns up to MAX_COMPLETION_ITEMS path suggestions for `value` within the
 * current allowed-directory state. Uses a per-McpServer WeakMap to isolate
 * rate-limit and cache state across HTTP sessions.
 */
async function completePath(value: string, options: CompletePathOptions): Promise<string[]> {
  const allowed = options.pathGuard.getAllowedDirectories();
  const argName = options.argumentName ?? '';

  try {
    const contextBase = await resolveContextBaseDirectory(
      argName,
      options.contextArguments,
      allowed,
    );

    if (!value && !contextBase) {
      return allowed.slice(0, MAX_COMPLETION_ITEMS);
    }

    const context = getSearchContext(value, allowed, contextBase);
    if (!context) {
      return findRootPrefixMatches(value, allowed).slice(0, MAX_COMPLETION_ITEMS);
    }

    const { searchDir, prefix } = context;
    const dirMatches = await findMatchesInDirectory(searchDir, prefix, allowed);
    const rootMatches = findMatchingRoots(searchDir, prefix, allowed);
    return mergeCompletionMatches(dirMatches, rootMatches).slice(0, MAX_COMPLETION_ITEMS);
  } catch {
    return [];
  }
}

/**
 * Rate-limited, cached wrapper around completePath.
 * Use this in completable() callbacks to avoid hammering the filesystem.
 */
export async function completePathCached(
  value: string,
  options: CompletePathOptions,
): Promise<string[]> {
  if (!options.server) return completePath(value, options);

  const cacheKey = buildCacheKey(options.argumentName ?? '', value, options.contextArguments);
  const now = Date.now();
  const sessionState = getCompletionState(options.server);
  const cacheEntry = sessionState.cache.get(cacheKey);

  if (cacheEntry && now - cacheEntry.ms < COMPLETION_RATE_LIMIT_MS) {
    return cacheEntry.result;
  }

  const results = await completePath(value, options);
  setCacheValue(sessionState.cache, cacheKey, { ms: now, result: results });
  return results;
}

export function createBase64JsonCodec<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodCodec<z.ZodString, Schema> {
  return z.codec(z.string(), schema, {
    decode: (value) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'));
      } catch (error) {
        throw new Error('Invalid base64url-encoded JSON payload.', {
          cause: error,
        });
      }

      // Cast to the codec's declared decode return type. The downstream
      // schema runs immediately after `decode` and validates the actual shape,
      // so this assertion only satisfies the codec contract — it is not trusted.
      return parsed as z.input<Schema>;
    },
    encode: (value) => Buffer.from(JSON.stringify(value)).toString('base64url'),
  });
}
