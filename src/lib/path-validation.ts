import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { Root } from '@modelcontextprotocol/sdk/types.js';

import type { ValidatedPathDetails } from '../config/types.js';
import { ErrorCode, McpError } from './errors.js';
import { normalizePath } from './path-utils.js';

let allowedDirectories: string[] = [];

export function setAllowedDirectories(dirs: string[]): void {
  const normalized = dirs.map(normalizePath).filter((d) => d.length > 0);
  allowedDirectories = [...new Set(normalized)];
}

export function getAllowedDirectories(): string[] {
  return [...allowedDirectories];
}

const PATH_SEPARATOR = process.platform === 'win32' ? '\\' : '/';

function normalizeForComparison(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isPathWithinAllowedDirectories(normalizedPath: string): boolean {
  const candidate = normalizeForComparison(normalizedPath);
  return allowedDirectories.some((allowedDir) => {
    const allowed = normalizeForComparison(allowedDir);
    return (
      candidate === allowed || candidate.startsWith(allowed + PATH_SEPARATOR)
    );
  });
}

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

async function validateExistingPathDetailsInternal(
  requestedPath: string
): Promise<ValidatedPathDetails> {
  if (!requestedPath || requestedPath.trim().length === 0) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path cannot be empty or whitespace',
      requestedPath
    );
  }

  // Check for null bytes (path truncation attack prevention)
  if (requestedPath.includes('\0')) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path contains null bytes',
      requestedPath
    );
  }

  // Check for Windows reserved device names
  if (process.platform === 'win32') {
    const segments = requestedPath.split(/[\\/]/);
    for (const segment of segments) {
      const baseName = segment.split('.')[0]?.toUpperCase();
      if (baseName && RESERVED_DEVICE_NAMES.has(baseName)) {
        throw new McpError(
          ErrorCode.E_INVALID_INPUT,
          `Windows reserved device name not allowed: ${baseName}`,
          requestedPath
        );
      }
    }
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
        `Too many symbolic links in path (possible circular reference): ${requestedPath}`,
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
    const allowedDirs = getAllowedDirectories();
    const suggestion =
      allowedDirs.length > 0
        ? `Allowed directories:\n${allowedDirs.map((d) => `  - ${d}`).join('\n')}`
        : 'No allowed directories configured. Use CLI arguments or MCP roots protocol.';

    throw new McpError(
      ErrorCode.E_ACCESS_DENIED,
      `Access denied: Path '${requestedPath}' is outside allowed directories.\n\n${suggestion}`,
      requestedPath,
      { resolvedPath: realPath, normalizedResolvedPath: normalizedReal }
    );
  }

  const isSymlink = normalizedRequested !== normalizedReal;

  return {
    requestedPath: normalizedRequested,
    resolvedPath: normalizedReal,
    isSymlink,
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

export async function getValidRootDirectories(
  roots: Root[]
): Promise<string[]> {
  const validDirs: string[] = [];

  for (const root of roots) {
    if (!root.uri.startsWith('file://')) {
      continue;
    }

    try {
      const dirPath = fileURLToPath(root.uri);
      const normalizedPath = normalizePath(dirPath);

      const stats = await fs.stat(normalizedPath);
      if (stats.isDirectory()) {
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
