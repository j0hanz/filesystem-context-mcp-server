import { ErrorCode, McpError } from '../errors.js';
import { getAllowedDirectories } from './allowed-directories.js';

function createMcpError(
  code: ErrorCode,
  message: string,
  requestedPath: string,
  details: Record<string, unknown>,
  cause: unknown
): McpError {
  return new McpError(code, message, requestedPath, details, cause);
}

function buildAllowedDirectoriesHint(): string {
  const allowedDirs = getAllowedDirectories();
  return allowedDirs.length > 0
    ? `Allowed directories:\n${allowedDirs.map((d) => `  - ${d}`).join('\n')}`
    : 'No allowed directories configured. Use CLI arguments or MCP roots protocol.';
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
    return createMcpError(
      mapping.code,
      mapping.message(requestedPath),
      requestedPath,
      { originalCode: code },
      error
    );
  }

  return createMcpError(
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
