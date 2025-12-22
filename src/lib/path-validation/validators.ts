import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

import { ErrorCode, McpError } from '../errors.js';
import { normalizePath } from '../path-utils.js';
import {
  isPathWithinAllowedDirectories,
  normalizeForComparison,
  RESERVED_DEVICE_NAMES,
} from './allowed-directories.js';
import { toAccessDeniedWithHint, toMcpError } from './errors.js';

interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
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

function getReservedDeviceName(segment: string): string | undefined {
  const baseName = segment.split('.')[0]?.toUpperCase();
  if (!baseName) return undefined;
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

function ensureWithinAllowedDirectories(
  normalizedPath: string,
  requestedPath: string,
  details?: Record<string, unknown>
): void {
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
  return normalizePath(requestedPath);
}

async function resolveRealPath(
  requestedPath: string,
  normalizedRequested: string
): Promise<string> {
  try {
    return await fs.realpath(normalizedRequested);
  } catch (error) {
    throw toMcpError(requestedPath, error);
  }
}

async function assertIsDirectory(
  resolvedPath: string,
  requestedPath: string
): Promise<void> {
  let stats: Stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (error) {
    throw toMcpError(requestedPath, error);
  }

  if (stats.isDirectory()) return;

  throw new McpError(
    ErrorCode.E_NOT_DIRECTORY,
    `Not a directory: ${requestedPath}`,
    requestedPath
  );
}

async function validateExistingPathDetailsInternal(
  requestedPath: string
): Promise<ValidatedPathDetails> {
  const normalizedRequested = validateRequestedPath(requestedPath);

  ensureWithinAllowedDirectories(normalizedRequested, requestedPath, {
    normalizedPath: normalizedRequested,
  });

  const realPath = await resolveRealPath(requestedPath, normalizedRequested);
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
  requestedPath: string
): Promise<ValidatedPathDetails> {
  return validateExistingPathDetailsInternal(requestedPath);
}

export async function validateExistingPath(
  requestedPath: string
): Promise<string> {
  const details = await validateExistingPathDetailsInternal(requestedPath);
  return details.resolvedPath;
}

export async function validateExistingDirectory(
  requestedPath: string
): Promise<string> {
  const details = await validateExistingPathDetailsInternal(requestedPath);
  await assertIsDirectory(details.resolvedPath, requestedPath);
  return details.resolvedPath;
}
