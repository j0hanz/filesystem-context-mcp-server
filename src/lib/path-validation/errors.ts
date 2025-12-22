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

export function toMcpError(requestedPath: string, error: unknown): McpError {
  const nodeError = error as NodeJS.ErrnoException;
  const { code } = nodeError;

  if (code === 'ENOENT') {
    return createMcpError(
      ErrorCode.E_NOT_FOUND,
      `Path does not exist: ${requestedPath}`,
      requestedPath,
      { originalCode: code },
      error
    );
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return createMcpError(
      ErrorCode.E_PERMISSION_DENIED,
      `Permission denied accessing path: ${requestedPath}`,
      requestedPath,
      { originalCode: code },
      error
    );
  }

  if (code === 'ELOOP') {
    return createMcpError(
      ErrorCode.E_SYMLINK_NOT_ALLOWED,
      `Too many symbolic links in path (possible circular reference): ${requestedPath}`,
      requestedPath,
      { originalCode: code },
      error
    );
  }

  if (code === 'ENAMETOOLONG') {
    return createMcpError(
      ErrorCode.E_INVALID_INPUT,
      `Path name too long: ${requestedPath}`,
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
    `Access denied: Path '${requestedPath}' is outside allowed directories.\n\n${suggestion}`,
    requestedPath,
    { resolvedPath, normalizedResolvedPath: normalizedResolved }
  );
}
