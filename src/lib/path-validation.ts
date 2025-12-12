/**
 * Path validation and security module for filesystem access control.
 *
 * This module is the SECURITY BOUNDARY of the MCP server.
 * All filesystem operations MUST call validateExistingPath() before accessing any path.
 *
 * Security properties:
 * - Prevents access to paths outside allowed directories
 * - Prevents symlink escapes (validates both requested path and resolved realpath)
 * - Normalizes paths consistently across platforms
 *
 * ## TOCTOU (Time-of-Check-Time-of-Use) Considerations
 *
 * This module validates paths at a point in time. Between validation and actual
 * file operations, the filesystem state may change (race condition). This is an
 * inherent limitation of path-based filesystem access that cannot be fully mitigated
 * without kernel-level support.
 *
 * **Mitigations applied:**
 * 1. **Symlink resolution**: We resolve symlinks during validation via `fs.realpath()`,
 *    ensuring the resolved target is within allowed directories at validation time.
 * 2. **Short validation window**: Validation is performed immediately before operations
 *    to minimize the race window.
 * 3. **Read-only operations**: This server only performs read operations, limiting the
 *    impact of TOCTOU races (no data corruption risk).
 *
 * **Residual risks:**
 * - A file could be replaced with a symlink between validation and read
 * - A directory could be replaced with a symlink junction (Windows)
 * - File permissions could change between validation and access
 *
 * **For higher security requirements:**
 * - Use `O_NOFOLLOW` flag where supported (Linux)
 * - Use file handles (`fs.open()`) and operate on handles instead of paths
 * - Consider sandboxing at the OS level (containers, namespaces)
 *
 * @see https://cwe.mitre.org/data/definitions/367.html - CWE-367: TOCTOU Race Condition
 */
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import { ErrorCode, McpError } from './errors.js';
import { normalizePath } from './path-utils.js';

/** Internal storage for allowed directories */
let allowedDirectories: string[] = [];

/**
 * Set the list of directories that this server is allowed to access.
 * All paths are normalized before storage.
 */
export function setAllowedDirectories(dirs: string[]): void {
  const normalized = dirs.map(normalizePath).filter((d) => d.length > 0);
  allowedDirectories = [...new Set(normalized)];
}

/**
 * Get a copy of the current allowed directories list.
 */
export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

const PATH_SEPARATOR = process.platform === 'win32' ? '\\' : '/';

/**
 * Normalize path for comparison (case-insensitive on Windows)
 */
function normalizeForComparison(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Check if a normalized path is within allowed directories.
 */
function isPathWithinAllowedDirectories(normalizedPath: string): boolean {
  const candidate = normalizeForComparison(normalizedPath);
  return allowedDirectories.some((allowedDir) => {
    const allowed = normalizeForComparison(allowedDir);
    // Exact match or is a child path
    return (
      candidate === allowed || candidate.startsWith(allowed + PATH_SEPARATOR)
    );
  });
}

interface ValidatedPathDetails {
  /** Normalized version of the originally requested path (may still be a symlink). */
  requestedPath: string;
  /** Realpath-resolved absolute path (symlinks resolved). */
  resolvedPath: string;
  /** Whether the originally requested path is a symbolic link. */
  isSymlink: boolean;
}

async function validateExistingPathDetailsInternal(
  requestedPath: string
): Promise<ValidatedPathDetails> {
  // Validate input is not empty or only whitespace
  if (!requestedPath || requestedPath.trim().length === 0) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path cannot be empty or whitespace',
      requestedPath
    );
  }

  const normalizedRequested = normalizePath(requestedPath);

  if (!isPathWithinAllowedDirectories(normalizedRequested)) {
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      `Access denied: Path '${requestedPath}' is outside allowed directories`,
      requestedPath,
      { normalizedPath: normalizedRequested }
    );
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(normalizedRequested);
  } catch (error) {
    // Distinguish between different error types for better error messages
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      throw new McpError(
        ErrorCode.E_NOT_FOUND,
        `Path does not exist: ${requestedPath}`,
        requestedPath,
        { originalCode: nodeError.code },
        error
      );
    }
    if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
      throw new McpError(
        ErrorCode.E_PERMISSION_DENIED,
        `Permission denied accessing path: ${requestedPath}`,
        requestedPath,
        { originalCode: nodeError.code },
        error
      );
    }
    if (nodeError.code === 'ELOOP') {
      throw new McpError(
        ErrorCode.E_SYMLINK_NOT_ALLOWED,
        `Too many symbolic links in path: ${requestedPath}`,
        requestedPath,
        { originalCode: nodeError.code },
        error
      );
    }
    if (nodeError.code === 'ENAMETOOLONG') {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        `Path name too long: ${requestedPath}`,
        requestedPath,
        { originalCode: nodeError.code },
        error
      );
    }
    // Generic fallback for other errors
    throw new McpError(
      ErrorCode.E_NOT_FOUND,
      `Path is not accessible: ${requestedPath}`,
      requestedPath,
      { originalCode: nodeError.code, originalMessage: nodeError.message },
      error
    );
  }
  const normalizedReal = normalizePath(realPath);

  if (!isPathWithinAllowedDirectories(normalizedReal)) {
    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      `Access denied: Path '${requestedPath}' resolves to '${realPath}' which is outside allowed directories (symlink escape attempt)`,
      requestedPath,
      { resolvedPath: realPath, normalizedResolvedPath: normalizedReal }
    );
  }

  // Detect if the *requested* path is a symlink without following it.
  // Note: lstat runs after the allowed-directory string check above.
  let isSymlink = false;
  try {
    const lstats = await fs.lstat(normalizedRequested);
    isSymlink = lstats.isSymbolicLink();
  } catch {
    // If lstat fails but realpath succeeded, treat as non-symlink.
    // This can happen on some platforms/filesystems; safe default.
    isSymlink = false;
  }

  return {
    requestedPath: normalizedRequested,
    resolvedPath: normalizedReal,
    isSymlink,
  };
}

/**
 * Like validateExistingPath(), but also returns the normalized requested path and whether it was a symlink.
 * Useful for operations that need to report on symlinks without traversing them.
 */
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

/**
 * Validates and extracts valid directory paths from MCP Root objects.
 * Only file:// URIs pointing to existing directories are accepted.
 */
export async function getValidRootDirectories(
  roots: Root[]
): Promise<string[]> {
  const validDirs: string[] = [];

  for (const root of roots) {
    // Only accept file:// URIs
    if (!root.uri.startsWith('file://')) {
      continue;
    }

    try {
      const dirPath = fileURLToPath(root.uri);
      const normalizedPath = normalizePath(dirPath);

      // Verify the directory exists and is accessible
      const stats = await fs.stat(normalizedPath);
      if (stats.isDirectory()) {
        // Resolve symlinks to get the real path
        try {
          const realPath = await fs.realpath(normalizedPath);
          validDirs.push(normalizePath(realPath));
        } catch {
          // If realpath fails, use the normalized path
          validDirs.push(normalizedPath);
        }
      } else {
        console.error(`Skipping root (not a directory): ${normalizedPath}`);
      }
    } catch {
      continue;
    }
  }

  return validDirs;
}
