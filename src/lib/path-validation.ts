import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode, McpError } from './errors.js';
import { isPathWithinRoot, normalizePath } from './path-utils.js';

const PATH_SEPARATOR = process.platform === 'win32' ? '\\' : '/';

export const RESERVED_DEVICE_NAMES = new Set([
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

let allowedDirectories: string[] = [];

export function normalizeForComparison(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function stripTrailingSeparator(normalized: string): string {
  return normalized.endsWith(PATH_SEPARATOR)
    ? normalized.slice(0, -1)
    : normalized;
}

function normalizeAllowedDirectory(dir: string): string {
  const normalized = normalizePath(dir.trim());
  if (normalized.length === 0) return '';

  const { root } = path.parse(normalized);
  const isRootPath =
    normalizeForComparison(root) === normalizeForComparison(normalized);
  if (isRootPath) return root;

  return stripTrailingSeparator(normalized);
}

export function setAllowedDirectories(dirs: string[]): void {
  const normalized = dirs
    .map(normalizeAllowedDirectory)
    .filter((d) => d.length > 0);
  allowedDirectories = [...new Set(normalized)];
}

export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: string[]
): boolean {
  const candidate = normalizeForComparison(normalizedPath);
  return allowedDirs.some((allowedDir) =>
    isPathWithinRoot(normalizeForComparison(allowedDir), candidate)
  );
}

export function isPathWithinAllowedDirectories(
  normalizedPath: string
): boolean {
  return isPathWithinDirectories(normalizedPath, allowedDirectories);
}

async function expandAllowedDirectories(dirs: string[]): Promise<string[]> {
  const expanded: string[] = [];

  for (const dir of dirs) {
    const normalized = normalizeAllowedDirectory(dir);
    if (!normalized) continue;
    expanded.push(normalized);

    const normalizedReal = await resolveRealPath(normalized);
    if (
      normalizedReal &&
      normalizeForComparison(normalizedReal) !==
        normalizeForComparison(normalized)
    ) {
      expanded.push(normalizedReal);
    }
  }

  return [...new Set(expanded)];
}

async function resolveRealPath(normalized: string): Promise<string | null> {
  try {
    const realPath = await fs.realpath(normalized);
    return normalizeAllowedDirectory(realPath);
  } catch {
    return null;
  }
}

export async function setAllowedDirectoriesResolved(
  dirs: string[]
): Promise<void> {
  const expanded = await expandAllowedDirectories(dirs);
  setAllowedDirectories(expanded);
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
  const trimmed = segment.replace(/[ .]+$/g, '');
  const withoutStream = trimmed.split(':')[0] ?? '';
  const baseName = withoutStream.split('.')[0]?.toUpperCase();
  if (!baseName) return undefined;
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

function ensureNoReservedWindowsNames(requestedPath: string): void {
  if (process.platform !== 'win32') return;

  const segments = requestedPath.split(/[\\/]/);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        `Windows reserved device name not allowed: ${reserved}`,
        requestedPath
      );
    }
  }
}

function ensureNoWindowsDriveRelativePath(requestedPath: string): void {
  if (process.platform !== 'win32') return;
  if (/^[a-zA-Z]:(?![\\/])/.test(requestedPath)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
      requestedPath
    );
  }
}

function ensureWithinAllowedDirectories(
  normalizedPath: string,
  requestedPath: string,
  details?: Record<string, unknown>
): void {
  if (allowedDirectories.length === 0) {
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      'Access denied: No allowed directories configured. Use --allow-cwd or configure roots via the MCP Roots protocol.',
      requestedPath,
      details
    );
  }
  if (isPathWithinAllowedDirectories(normalizedPath)) return;

  throw new McpError(
    ErrorCode.E_ACCESS_DENIED,
    `Access denied: Path '${requestedPath}' is outside allowed directories`,
    requestedPath,
    details
  );
}

function validateRequestedPath(requestedPath: string): string {
  ensureNonEmptyPath(requestedPath);
  ensureNoNullBytes(requestedPath);
  ensureNoReservedWindowsNames(requestedPath);
  ensureNoWindowsDriveRelativePath(requestedPath);
  return normalizePath(requestedPath);
}

function buildAllowedDirectoriesHint(): string {
  const dirs = getAllowedDirectories();
  return dirs.length > 0
    ? `Allowed: ${dirs.join(', ')}`
    : 'No allowed directories configured.';
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

export function toMcpError(requestedPath: string, error: unknown): McpError {
  const nodeError = error as NodeJS.ErrnoException;
  const { code } = nodeError;
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
  return new McpError(
    ErrorCode.E_NOT_FOUND,
    `Path is not accessible: ${requestedPath}`,
    requestedPath,
    { originalCode: code, originalMessage: nodeError.message },
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

async function resolveRealPathOrThrow(
  requestedPath: string,
  normalizedRequested: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    if (signal?.aborted) throw new Error('AbortError');
    return await fs.realpath(normalizedRequested);
  } catch (error) {
    throw toMcpError(requestedPath, error);
  }
}

interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

async function validateExistingPathDetailsInternal(
  requestedPath: string,
  signal?: AbortSignal
): Promise<ValidatedPathDetails> {
  const normalizedRequested = validateRequestedPath(requestedPath);
  ensureWithinAllowedDirectories(normalizedRequested, requestedPath, {
    normalizedPath: normalizedRequested,
  });

  const realPath = await resolveRealPathOrThrow(
    requestedPath,
    normalizedRequested,
    signal
  );
  const normalizedReal = normalizePath(realPath);

  if (!isPathWithinAllowedDirectories(normalizedReal)) {
    throw toAccessDeniedWithHint(requestedPath, realPath, normalizedReal);
  }

  return {
    requestedPath: normalizedRequested,
    resolvedPath: normalizedReal,
    isSymlink:
      normalizeForComparison(normalizedRequested) !==
      normalizeForComparison(normalizedReal),
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
  if (signal?.aborted) throw new Error('AbortError');
  const stats = await fs.stat(details.resolvedPath);
  if (!stats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_DIRECTORY,
      `Not a directory: ${requestedPath}`,
      requestedPath
    );
  }
  return details.resolvedPath;
}

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

async function maybeAddRealPath(
  normalizedPath: string,
  validDirs: string[]
): Promise<void> {
  try {
    const realPath = await fs.realpath(normalizedPath);
    const normalizedReal = normalizePath(realPath);
    if (
      normalizeForComparison(normalizedReal) !==
      normalizeForComparison(normalizedPath)
    ) {
      validDirs.push(normalizedReal);
    }
  } catch {
    // ignore
  }
}

async function resolveRootDirectory(root: Root): Promise<string | null> {
  try {
    const dirPath = fileURLToPath(root.uri);
    const normalizedPath = normalizePath(dirPath);
    const stats = await fs.stat(normalizedPath);
    if (!stats.isDirectory()) return null;
    return normalizedPath;
  } catch {
    return null;
  }
}

export async function getValidRootDirectories(
  roots: Root[]
): Promise<string[]> {
  const validDirs: string[] = [];

  for (const root of roots) {
    if (!isFileRoot(root)) continue;

    const normalizedPath = await resolveRootDirectory(root);
    if (!normalizedPath) continue;

    validDirs.push(normalizedPath);
    await maybeAddRealPath(normalizedPath, validDirs);
  }

  return validDirs;
}
