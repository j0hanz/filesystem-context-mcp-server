import type { Root } from '@modelcontextprotocol/server';

import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNotAborted, withAbort } from './abort.js';
import { SENSITIVE_FILE_DENYLIST } from './constants.js';
import { ErrorCode, isAbortError, McpError } from './errors.js';
import { Logger } from './logger.js';
import {
  type AllowedDirectoriesState,
  dedupePreserveOrder,
  getDefaultPathGuard,
  IS_WINDOWS,
  isPathWithinDirectories,
  isSamePath,
  normalizeAllowedDirectory,
  normalizePath,
  type PathGuard,
  PathGuard as PathGuardClass,
  setDefaultPathGuard,
  toPosixPath,
  type ValidatedPathDetails,
} from './path-guard.js';

export type { AllowedDirectoriesState, PathGuard, ValidatedPathDetails };
export { isPathWithinDirectories, normalizePath, toPosixPath };

// ALS for HTTP session isolation — payload is PathGuard, not raw dirs.
// Each HTTP request runs inside withPathGuard() scoped to its session.
// Stdio reads the default singleton set by PathGuard.initialize().
const pathGuardContext = new AsyncLocalStorage<PathGuard>({
  name: 'filesystem-mcp:path-guard',
});

export function withPathGuard<T>(guard: PathGuard, run: () => T): T {
  return pathGuardContext.run(guard, run);
}

function getActivePathGuard(): PathGuard {
  return pathGuardContext.getStore() ?? getDefaultPathGuard();
}

// Thin wrappers for library code (fs-helpers, file-operations, path-completer)
// that cannot receive PathGuard via injection.
export function getAllowedDirectories(): string[] {
  return getActivePathGuard().getAllowedDirectories();
}

export function isAllowedDirectoryRoot(normalizedPath: string): boolean {
  for (const dir of getActivePathGuard().getAllowedDirectories()) {
    if (isSamePath(normalizedPath, dir)) return true;
  }
  return false;
}

export function isSensitivePath(
  requestedPath: string,
  _resolvedPath?: string
): boolean {
  return getActivePathGuard().isSensitive(requestedPath);
}

export function assertAllowedFileAccess(
  requestedPath: string,
  _resolvedPath?: string
): void {
  if (getActivePathGuard().isSensitive(requestedPath)) {
    Logger.warn(
      `Access denied: sensitive file blocked by policy (${requestedPath})`
    );
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
      requestedPath
    );
  }
}

export async function validateExistingPath(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal) assertNotAborted(signal);
  return getActivePathGuard().validateExistingPath(requestedPath);
}

export async function validateExistingPathDetailed(
  requestedPath: string,
  signal?: AbortSignal
): Promise<ValidatedPathDetails> {
  if (signal) assertNotAborted(signal);
  return getActivePathGuard().validateExistingPathDetailed(requestedPath);
}

export async function validateExistingDirectory(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal) assertNotAborted(signal);
  return getActivePathGuard().validateExistingDirectory(requestedPath);
}

export async function validatePathForWrite(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  if (signal) assertNotAborted(signal);
  return getActivePathGuard().validatePathForWrite(requestedPath);
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
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

async function resolveRealPath(
  normalized: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalized), signal);
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
  const guard = new PathGuardClass(SENSITIVE_FILE_DENYLIST);
  guard.initialize(state);
  setDefaultPathGuard(guard);
}

function getReservedDeviceName(segment: string): string | undefined {
  // Trim trailing dots/spaces (Windows ignores these in path segments).
  const CHAR_CODE_SPACE = 32;
  const CHAR_CODE_DOT = 46;
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c === CHAR_CODE_SPACE || c === CHAR_CODE_DOT) end--;
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

  const segments = requestedPath.split(/[\\/]/);
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

export function isSafeGlobPattern(pattern: string): boolean {
  return getActivePathGuard().isSafeGlob(pattern);
}

export function assertSafeGlobPattern(pattern: string, message?: string): void {
  getActivePathGuard().assertSafeGlob(pattern, message);
}
