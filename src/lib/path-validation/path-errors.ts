import { ErrorCode, isNodeError, McpError } from '../errors.js';
import { getAllowedDirectories } from './allowed-directories.js';

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

export function toMcpError(requestedPath: string, error: unknown): McpError {
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
  let message = '';
  if (error instanceof Error) {
    const { message: errorMessage } = error;
    message = errorMessage;
  } else if (typeof error === 'string') {
    message = error;
  }
  return new McpError(
    ErrorCode.E_NOT_FOUND,
    `Path is not accessible: ${requestedPath}`,
    requestedPath,
    { originalCode: code, originalMessage: message },
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
