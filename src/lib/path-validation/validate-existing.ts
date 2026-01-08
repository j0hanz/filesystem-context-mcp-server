import * as fs from 'node:fs/promises';

import { ErrorCode, McpError } from '../errors.js';
import { assertNotAborted, withAbort } from '../fs-helpers/abort.js';
import { normalizePath } from '../path-utils.js';
import {
  getAllowedDirectories,
  isPathWithinDirectories,
  normalizeForComparison,
} from './allowed-directories.js';
import { toAccessDeniedWithHint, toMcpError } from './path-errors.js';
import { validateRequestedPath } from './path-rules.js';

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
  if (allowedDirs.length === 0) {
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      'Access denied: No allowed directories configured. Use --allow-cwd or configure roots via the MCP Roots protocol.',
      requestedPath,
      details
    );
  }
  if (isPathWithinDirectories(normalizedPath, allowedDirs)) return;

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
    if (error instanceof Error && error.name === 'AbortError') {
      throw error;
    }
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
    signal,
  });
  const normalizedReal = normalizePath(realPath);

  if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
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
  assertNotAborted(signal);
  const stats = await withAbort(fs.stat(details.resolvedPath), signal);
  if (!stats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_DIRECTORY,
      `Not a directory: ${requestedPath}`,
      requestedPath
    );
  }
  return details.resolvedPath;
}
