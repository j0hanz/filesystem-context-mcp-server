import type { Root } from '@modelcontextprotocol/sdk/types.js';

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertNotAborted, withAbort } from './abort.js';
import {
  SENSITIVE_FILE_ALLOWLIST,
  SENSITIVE_FILE_DENYLIST,
} from './constants.js';
import { ErrorCode, isAbortError, isNodeError, McpError } from './errors.js';
import { Logger } from './logger.js';

const WINDOWS_PATH_SEPARATOR = '\\';
const POSIX_PATH_SEPARATOR = '/';

export function toPosixPath(value: string): string {
  return value.includes(WINDOWS_PATH_SEPARATOR)
    ? value.replace(/\\/gu, POSIX_PATH_SEPARATOR)
    : value;
}

interface CompiledPattern {
  globs: readonly string[];
  matchesPath: boolean;
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

const IS_WINDOWS = platform() === 'win32';
const WINDOWS_ABSOLUTE_RE = /^[a-z]:\//iu;
const HOME_PREFIX_LENGTH = 2;
const CHAR_CODE_SPACE = 32;
const CHAR_CODE_DOT = 46;

function normalizePathForMatch(input: string): string {
  return toPosixPath(path.normalize(input));
}

function normalizeForMatch(input: string): string {
  const normalized = normalizePathForMatch(input);
  // Always lowercase for case-insensitive denylist matching on all platforms.
  // Prevents bypassing `.env` block with `.ENV` on case-sensitive filesystems.
  return normalized.toLowerCase();
}

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

const DENY_PATTERNS = toPatternSet(compilePatterns(SENSITIVE_FILE_DENYLIST));
const ALLOW_PATTERNS = toPatternSet(compilePatterns(SENSITIVE_FILE_ALLOWLIST));

function uniquePair(primary: string, secondary?: string): string[] {
  if (!secondary || secondary === primary) return [primary];
  return [primary, secondary];
}

function matchesAnyGlobs(
  globs: readonly string[],
  candidates: readonly string[]
): boolean {
  if (globs.length === 0 || candidates.length === 0) return false;

  for (const candidate of candidates) {
    for (const glob of globs) {
      if (path.posix.matchesGlob(candidate, glob)) return true;
    }
  }

  return false;
}

export function isSensitivePath(
  requestedPath: string,
  resolvedPath?: string
): boolean {
  if (
    DENY_PATTERNS.pathGlobs.length === 0 &&
    DENY_PATTERNS.nameGlobs.length === 0
  ) {
    return false;
  }

  const normalizedRequested = normalizeForMatch(requestedPath);
  const normalizedResolved = resolvedPath
    ? normalizeForMatch(resolvedPath)
    : undefined;

  const pathCandidates = uniquePair(normalizedRequested, normalizedResolved);
  const nameCandidates = uniquePair(
    path.posix.basename(normalizedRequested),
    normalizedResolved ? path.posix.basename(normalizedResolved) : undefined
  );

  if (
    matchesAnyGlobs(ALLOW_PATTERNS.pathGlobs, pathCandidates) ||
    matchesAnyGlobs(ALLOW_PATTERNS.nameGlobs, nameCandidates)
  ) {
    return false;
  }

  return (
    matchesAnyGlobs(DENY_PATTERNS.pathGlobs, pathCandidates) ||
    matchesAnyGlobs(DENY_PATTERNS.nameGlobs, nameCandidates)
  );
}

export function assertAllowedFileAccess(
  requestedPath: string,
  resolvedPath?: string
): void {
  if (!isSensitivePath(requestedPath, resolvedPath)) return;
  Logger.warn(
    `Access denied: sensitive file blocked by policy (${requestedPath})`
  );
  throw new McpError(
    ErrorCode.E_ACCESS_DENIED,
    `Access denied: sensitive file blocked by policy (${requestedPath}). ` +
      'Set FS_CONTEXT_ALLOW_SENSITIVE=1 or use FS_CONTEXT_ALLOWLIST to override.',
    requestedPath
  );
}

const HOMEDIR = os.homedir();
const PATH_SEPARATOR = path.sep;

const DRIVE_LETTER_REGEX = /^[A-Za-z]:/;
const WINDOWS_DRIVE_REL_REGEX = /^[A-Za-z]:$/u;
const LEADING_SEPARATORS_RE = /^[/\\]+/;

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

export interface AllowedDirectoriesState {
  primary: string[];
  expanded: string[];
}

const allowedDirectoriesContext =
  new AsyncLocalStorage<AllowedDirectoriesState>({
    name: 'filesystem-mcp:allowed-directories',
  });

function dedupePreserveOrder<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function cloneAllowedDirectoriesState(
  state: AllowedDirectoriesState
): AllowedDirectoriesState {
  return {
    primary: [...state.primary],
    expanded: [...state.expanded],
  };
}

function expandHome(filepath: string): string {
  if (filepath === '~') return HOMEDIR;

  // Accept both "~/" and "~\\" for cross-platform UX.
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    // Avoid `path.join(HOMEDIR, "/foo")` resetting to the filesystem root.
    const rest = filepath
      .slice(HOME_PREFIX_LENGTH)
      .replace(LEADING_SEPARATORS_RE, '');
    return rest.length === 0 ? HOMEDIR : path.join(HOMEDIR, rest);
  }

  return filepath;
}

/**
 * Normalizes any path-like input to an absolute path suitable for comparisons.
 * - Expands "~" home directory shorthand.
 * - Resolves against process CWD if relative.
 * - Lowercases Windows drive letter for stable comparisons.
 */
export function normalizePath(p: string): string {
  const resolved = path.resolve(expandHome(p));

  if (IS_WINDOWS && DRIVE_LETTER_REGEX.test(resolved)) {
    return resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }

  return resolved;
}

function normalizeCaseForComparison(value: string): string {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

function normalizeForComparison(value: string): string {
  return normalizeCaseForComparison(value);
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
}

function isSamePath(left: string, right: string): boolean {
  if (left === right) return true;
  const leftResolved = normalizeCaseForComparison(path.resolve(left));
  const rightResolved = normalizeCaseForComparison(path.resolve(right));
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
  const { root } = path.parse(normalized);

  // Keep filesystem roots as-is ("/", "c:\\", "\\\\server\\share\\").
  if (isFileSystemRootPath(normalized, root)) {
    return root;
  }

  return stripTrailingSeparator(normalized);
}

function normalizeAllowedDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const entry = normalizeAllowedDirectory(dir);
    if (entry.length > 0) {
      normalized.push(entry);
    }
  }

  // Preserve first-seen order while deduping.
  return dedupePreserveOrder(normalized);
}

// Process-global singleton state for allowed directory roots.
//
// These are set once at startup (via setAllowedDirectoriesResolved) and
// mutated only through setAllowedDirectoriesState. In stdio mode there is a
// single MCP session per process, so this is safe. In HTTP mode all HTTP
// sessions within the same process share one policy — multi-tenant isolation
// (different roots per session) requires separate server processes.
let defaultAllowedDirectoriesState: AllowedDirectoriesState = {
  primary: [],
  expanded: [],
};

function setAllowedDirectoriesState(
  primary: readonly string[],
  expanded: readonly string[]
): void {
  defaultAllowedDirectoriesState = {
    primary: dedupePreserveOrder(primary),
    expanded: dedupePreserveOrder(expanded),
  };
}

function getActiveAllowedDirectoriesState(): AllowedDirectoriesState {
  return allowedDirectoriesContext.getStore() ?? defaultAllowedDirectoriesState;
}

export function withAllowedDirectoriesState<T>(
  state: AllowedDirectoriesState,
  run: () => T
): T {
  return allowedDirectoriesContext.run(
    cloneAllowedDirectoriesState(state),
    run
  );
}

export function setAllowedDirectoriesStateResolved(
  state: AllowedDirectoriesState
): void {
  setAllowedDirectoriesState(state.primary, state.expanded);
}

export function getAllowedDirectories(): string[] {
  return [...getActiveAllowedDirectoriesState().expanded];
}

export function isAllowedDirectoryRoot(normalizedPath: string): boolean {
  for (const dir of getActiveAllowedDirectoriesState().expanded) {
    if (isSamePath(normalizedPath, dir)) return true;
  }
  return false;
}

function getAllowedDirectoriesForRelativeResolution(): readonly string[] {
  const state = getActiveAllowedDirectoriesState();
  return state.primary.length > 0 ? state.primary : state.expanded;
}

function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string
): boolean {
  const root = normalizeForComparison(normalizedDirectory);
  const candidate = normalizeForComparison(normalizedCandidate);

  if (root === candidate) return true;

  const relative = path.relative(root, candidate);
  if (relative.length === 0) return true;
  if (relative === '..') return false;

  return (
    !relative.startsWith('..\\') &&
    !relative.startsWith('../') &&
    !path.isAbsolute(relative)
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

async function resolveRealPath(
  normalized: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(fs.realpath(normalized), signal);
    return normalizeAllowedDirectory(realPath);
  } catch (error) {
    rethrowIfAborted(error);
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

export async function setAllowedDirectoriesResolved(
  dirs: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  const state = await resolveAllowedDirectoriesState(dirs, signal);
  setAllowedDirectoriesStateResolved(state);
}

function ensureNonEmptyPath(requestedPath: string): void {
  if (!requestedPath || requestedPath.trim().length === 0) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path cannot be empty or whitespace',
      requestedPath
    );
  }
}

function ensureNoNullBytes(requestedPath: string): void {
  if (requestedPath.includes('\0')) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path contains null bytes',
      requestedPath
    );
  }
}

function getReservedDeviceName(segment: string): string | undefined {
  // Trim trailing dots/spaces (Windows ignores these in path segments).
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c === CHAR_CODE_SPACE || c === CHAR_CODE_DOT)
      end--; // space or dot
    else break;
  }

  const trimmed = segment.slice(0, end);

  // Remove alternate data stream suffix (e.g. "file.txt:stream").
  const streamIdx = trimmed.indexOf(':');
  const withoutStream =
    streamIdx !== -1 ? trimmed.slice(0, streamIdx) : trimmed;

  // Remove extension (e.g. "CON.txt" => "CON").
  const dotIdx = withoutStream.indexOf('.');
  const baseName = (
    dotIdx !== -1 ? withoutStream.slice(0, dotIdx) : withoutStream
  ).toUpperCase();

  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

export function getReservedDeviceNameForPath(
  requestedPath: string
): string | undefined {
  if (!IS_WINDOWS) return undefined;

  const segments = requestedPath.split(/[\\/]/);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) return reserved;
  }

  return undefined;
}

function ensureNoReservedWindowsNames(requestedPath: string): void {
  if (!IS_WINDOWS) return;

  const reserved = getReservedDeviceNameForPath(requestedPath);
  if (!reserved) return;

  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Windows reserved device name not allowed: ${reserved}`,
    requestedPath
  );
}

export function isWindowsDriveRelativePath(requestedPath: string): boolean {
  if (!IS_WINDOWS) return false;

  const parsed = path.win32.parse(requestedPath);
  if (!WINDOWS_DRIVE_REL_REGEX.test(parsed.root)) return false;
  return !path.win32.isAbsolute(requestedPath);
}

function ensureNoWindowsDriveRelativePath(requestedPath: string): void {
  if (!isWindowsDriveRelativePath(requestedPath)) return;

  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
    requestedPath
  );
}

function resolveRequestedPath(requestedPath: string): string {
  const expanded = expandHome(requestedPath);

  if (!path.isAbsolute(expanded)) {
    const roots = getAllowedDirectoriesForRelativeResolution();

    if (roots.length > 1) {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        'Relative paths are ambiguous when multiple roots are configured. Provide an absolute path or specify the full root path.',
        requestedPath
      );
    }

    const baseDir = roots[0];
    if (baseDir) {
      return normalizePath(path.resolve(baseDir, expanded));
    }
  }

  return normalizePath(expanded);
}

function validateRequestedPath(requestedPath: string): string {
  ensureNonEmptyPath(requestedPath);
  ensureNoNullBytes(requestedPath);
  ensureNoReservedWindowsNames(requestedPath);
  ensureNoWindowsDriveRelativePath(requestedPath);
  return resolveRequestedPath(requestedPath);
}

const NODE_ERROR_MAP: Readonly<
  Record<
    string,
    { code: ErrorCode; message: (requestedPath: string) => string }
  >
> = {
  ENOENT: {
    code: ErrorCode.E_NOT_FOUND,
    message: (requestedPath) => `Path does not exist: ${requestedPath}`,
  },
  EACCES: {
    code: ErrorCode.E_PERMISSION_DENIED,
    message: (requestedPath) =>
      `Permission denied accessing path: ${requestedPath}`,
  },
  EPERM: {
    code: ErrorCode.E_PERMISSION_DENIED,
    message: (requestedPath) =>
      `Permission denied accessing path: ${requestedPath}`,
  },
  ELOOP: {
    code: ErrorCode.E_SYMLINK_NOT_ALLOWED,
    message: (requestedPath) =>
      `Too many symbolic links in path (possible circular reference): ${requestedPath}`,
  },
  ENAMETOOLONG: {
    code: ErrorCode.E_INVALID_INPUT,
    message: (requestedPath) => `Path name too long: ${requestedPath}`,
  },
} as const;

function buildAllowedDirectoriesHint(): string {
  const dirs = getAllowedDirectories();
  return dirs.length > 0
    ? `Allowed: ${dirs.join(', ')}`
    : 'No allowed directories configured.';
}

function toMcpError(requestedPath: string, error: unknown): McpError {
  const code = isNodeError(error) ? error.code : undefined;
  const mapping = code ? NODE_ERROR_MAP[code] : undefined;

  if (mapping) {
    return new McpError(
      mapping.code,
      mapping.message(requestedPath),
      requestedPath,
      { originalCode: code },
      error
    );
  }

  let originalMessage = '';
  if (error instanceof Error) {
    originalMessage = error.message;
  } else if (typeof error === 'string') {
    originalMessage = error;
  }

  return new McpError(
    ErrorCode.E_NOT_FOUND,
    `Path is not accessible: ${requestedPath}`,
    requestedPath,
    { originalCode: code, originalMessage },
    error
  );
}

function toAccessDeniedWithHint(
  requestedPath: string,
  resolvedPath: string,
  normalizedResolved: string
): McpError {
  const suggestion = buildAllowedDirectoriesHint();
  return new McpError(
    ErrorCode.E_ACCESS_DENIED,
    `Access denied: Path '${requestedPath}' is outside allowed directories.\n${suggestion}`,
    requestedPath,
    { resolvedPath, normalizedResolvedPath: normalizedResolved }
  );
}

interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

interface PreparedPathAccess {
  allowedDirs: string[];
  normalizedRequested: string;
}

function ensureWithinAllowedDirectories(options: {
  normalizedPath: string;
  requestedPath: string;
  allowedDirs: readonly string[];
  details?: Record<string, unknown>;
}): void {
  const { normalizedPath, requestedPath, allowedDirs, details } = options;

  if (isPathWithinDirectories(normalizedPath, allowedDirs)) return;

  if (allowedDirs.length === 0) {
    Logger.warn('Access denied: no allowed directories configured');
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      'Access denied: No allowed directories configured. Use --allow-cwd or configure roots via the MCP Roots protocol.',
      requestedPath,
      details
    );
  }

  Logger.warn(
    `Access denied: path outside allowed directories (${requestedPath})`
  );
  throw new McpError(
    ErrorCode.E_ACCESS_DENIED,
    `Access denied: Path '${requestedPath}' is outside allowed directories`,
    requestedPath,
    details
  );
}

async function resolveRealPathOrThrow(options: {
  requestedPath: string;
  normalizedRequested: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { requestedPath, normalizedRequested, signal } = options;

  try {
    assertNotAborted(signal);
    return await withAbort(fs.realpath(normalizedRequested), signal);
  } catch (error) {
    rethrowIfAborted(error);
    throw toMcpError(requestedPath, error);
  }
}

function preparePathAccess(requestedPath: string): PreparedPathAccess {
  const normalizedRequested = validateRequestedPath(requestedPath);
  const allowedDirs = getAllowedDirectories();

  ensureWithinAllowedDirectories({
    normalizedPath: normalizedRequested,
    requestedPath,
    allowedDirs,
    details: { normalizedPath: normalizedRequested },
  });

  return { allowedDirs, normalizedRequested };
}

function ensureResolvedPathAllowed(options: {
  requestedPath: string;
  resolvedPath: string;
  normalizedResolved: string;
  allowedDirs: readonly string[];
}): void {
  const { requestedPath, resolvedPath, normalizedResolved, allowedDirs } =
    options;
  if (isPathWithinDirectories(normalizedResolved, allowedDirs)) return;
  throw toAccessDeniedWithHint(requestedPath, resolvedPath, normalizedResolved);
}

async function statPathOrThrow(
  requestedPath: string,
  resolvedPath: string,
  signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  try {
    assertNotAborted(signal);
    return await withAbort(fs.stat(resolvedPath), signal);
  } catch (error) {
    rethrowIfAborted(error);
    throw toMcpError(requestedPath, error);
  }
}

async function resolveNearestExistingRealPathOrThrow(options: {
  requestedPath: string;
  startPath: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { requestedPath, startPath, signal } = options;

  let current = startPath;
  for (;;) {
    try {
      assertNotAborted(signal);
      return await withAbort(fs.realpath(current), signal);
    } catch (error) {
      rethrowIfAborted(error);
      const code = isNodeError(error) ? error.code : undefined;
      if (code !== 'ENOENT') {
        throw toMcpError(requestedPath, error);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw toMcpError(requestedPath, error);
      }
      current = parent;
    }
  }
}

async function validateExistingPathDetailsInternal(
  requestedPath: string,
  signal?: AbortSignal
): Promise<ValidatedPathDetails> {
  const { allowedDirs, normalizedRequested } = preparePathAccess(requestedPath);

  const realPath = await resolveRealPathOrThrow({
    requestedPath,
    normalizedRequested,
    ...(signal ? { signal } : {}),
  });

  const normalizedReal = normalizePath(realPath);
  ensureResolvedPathAllowed({
    requestedPath,
    resolvedPath: realPath,
    normalizedResolved: normalizedReal,
    allowedDirs,
  });

  return {
    requestedPath: normalizedRequested,
    resolvedPath: normalizedReal,
    isSymlink: !isSamePath(normalizedRequested, normalizedReal),
  };
}

export async function validateExistingPathDetailed(
  requestedPath: string,
  signal?: AbortSignal
): Promise<ValidatedPathDetails> {
  return validateExistingPathDetailsInternal(requestedPath, signal);
}

export async function validateExistingPath(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  const details = await validateExistingPathDetailsInternal(
    requestedPath,
    signal
  );
  return details.resolvedPath;
}

export async function validateExistingDirectory(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  const details = await validateExistingPathDetailsInternal(
    requestedPath,
    signal
  );

  const stats = await statPathOrThrow(
    requestedPath,
    details.resolvedPath,
    signal
  );

  if (!stats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_DIRECTORY,
      `Not a directory: ${requestedPath}`,
      requestedPath
    );
  }

  return details.resolvedPath;
}

export async function validatePathForWrite(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  const { allowedDirs, normalizedRequested } = preparePathAccess(requestedPath);

  assertAllowedFileAccess(requestedPath, normalizedRequested);

  const realPath = await resolveNearestExistingRealPathOrThrow({
    requestedPath,
    startPath: normalizedRequested,
    ...(signal ? { signal } : {}),
  });
  const normalizedReal = normalizePath(realPath);

  ensureResolvedPathAllowed({
    requestedPath,
    resolvedPath: realPath,
    normalizedResolved: normalizedReal,
    allowedDirs,
  });

  return normalizedRequested;
}

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

async function maybeAddRealPath(
  normalizedPath: string,
  validDirs: string[],
  signal?: AbortSignal
): Promise<void> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(fs.realpath(normalizedPath), signal);
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
    const stats = await withAbort(fs.stat(normalizedPath), signal);

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

  // Phase 1: Resolve all roots in parallel (order-preserving via index).
  const resolvedResults = await Promise.all(
    fileRoots.map((root) => resolveRootDirectory(root, signal))
  );
  const validPaths = resolvedResults.filter((p): p is string => p !== null);

  if (validPaths.length === 0) return [];

  // Phase 2: Expand real paths for each valid directory in parallel.
  const realExpansions = await Promise.all(
    validPaths.map(async (normalizedPath) => {
      const extra: string[] = [];
      await maybeAddRealPath(normalizedPath, extra, signal);
      return extra[0] ?? null;
    })
  );

  // Build output preserving insertion order: [normalizedPath, realPath?] per root.
  const validDirs: string[] = [];
  validPaths.forEach((p, i) => {
    validDirs.push(p);
    const expanded = realExpansions[i];
    if (expanded !== null && expanded !== undefined) {
      validDirs.push(expanded);
    }
  });

  return validDirs;
}
