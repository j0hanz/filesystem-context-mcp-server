import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode, isAbortError, isNodeError, McpError } from './errors.js';
import { assertNotAborted, withAbort } from './fs-helpers.js';

const IS_WINDOWS = os.platform() === 'win32';
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

function dedupePreserveOrder<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function expandHome(filepath: string): string {
  if (filepath === '~') return HOMEDIR;

  // Accept both "~/" and "~\\" for cross-platform UX.
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    // Avoid `path.join(HOMEDIR, "/foo")` resetting to the filesystem root.
    const rest = filepath.slice(2).replace(LEADING_SEPARATORS_RE, '');
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

function normalizeForComparison(value: string): string {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
}

function isSamePath(left: string, right: string): boolean {
  if (left === right) return true;
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return IS_WINDOWS
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
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

// Cached module state (configured roots).
let allowedDirectoriesExpanded: string[] = [];
let allowedDirectoriesPrimary: string[] = [];

function setAllowedDirectoriesState(
  primary: readonly string[],
  expanded: readonly string[]
): void {
  allowedDirectoriesPrimary = dedupePreserveOrder(primary);
  allowedDirectoriesExpanded = dedupePreserveOrder(expanded);
}

export function getAllowedDirectories(): string[] {
  return [...allowedDirectoriesExpanded];
}

function getAllowedDirectoriesForRelativeResolution(): readonly string[] {
  return allowedDirectoriesPrimary.length > 0
    ? allowedDirectoriesPrimary
    : allowedDirectoriesExpanded;
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

export async function setAllowedDirectoriesResolved(
  dirs: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  const primary = normalizeAllowedDirectories(dirs);
  const expanded = await expandAllowedDirectories(primary, signal);
  setAllowedDirectoriesState(primary, expanded);
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
    if (c === 32 || c === 46)
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

export function toAccessDeniedWithHint(
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

function ensureWithinAllowedDirectories(options: {
  normalizedPath: string;
  requestedPath: string;
  allowedDirs: readonly string[];
  details?: Record<string, unknown>;
}): void {
  const { normalizedPath, requestedPath, allowedDirs, details } = options;

  if (isPathWithinDirectories(normalizedPath, allowedDirs)) return;

  if (allowedDirs.length === 0) {
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      'Access denied: No allowed directories configured. Use --allow-cwd or configure roots via the MCP Roots protocol.',
      requestedPath,
      details
    );
  }

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

async function validateExistingPathDetailsInternal(
  requestedPath: string,
  signal?: AbortSignal
): Promise<ValidatedPathDetails> {
  const normalizedRequested = validateRequestedPath(requestedPath);
  const allowedDirs = getAllowedDirectories();

  ensureWithinAllowedDirectories({
    normalizedPath: normalizedRequested,
    requestedPath,
    allowedDirs,
    details: { normalizedPath: normalizedRequested },
  });

  const realPath = await resolveRealPathOrThrow({
    requestedPath,
    normalizedRequested,
    ...(signal ? { signal } : {}),
  });

  const normalizedReal = normalizePath(realPath);

  if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
    throw toAccessDeniedWithHint(requestedPath, realPath, normalizedReal);
  }

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

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    assertNotAborted(signal);
    stats = await withAbort(fs.stat(details.resolvedPath), signal);
  } catch (error) {
    rethrowIfAborted(error);
    throw toMcpError(requestedPath, error);
  }

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
  const normalizedRequested = validateRequestedPath(requestedPath);
  const allowedDirs = getAllowedDirectories();

  ensureWithinAllowedDirectories({
    normalizedPath: normalizedRequested,
    requestedPath,
    allowedDirs,
    details: { normalizedPath: normalizedRequested },
  });

  let current = normalizedRequested;
  for (;;) {
    try {
      assertNotAborted(signal);
      const realPath = await withAbort(fs.realpath(current), signal);
      const normalizedReal = normalizePath(realPath);

      if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
        throw toAccessDeniedWithHint(requestedPath, realPath, normalizedReal);
      }

      return normalizedRequested;
    } catch (error) {
      rethrowIfAborted(error);
      const code = isNodeError(error) ? error.code : undefined;
      if (code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) {
          throw toMcpError(requestedPath, error);
        }
        current = parent;
        continue;
      }
      throw toMcpError(requestedPath, error);
    }
  }
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
