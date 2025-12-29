import { joinLines } from '../config/formatting.js';
import { ErrorCode } from '../config/types.js';

export { ErrorCode };

interface DetailedError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  );
}

export const NODE_ERROR_CODE_MAP: Readonly<Record<string, ErrorCode>> = {
  ENOENT: ErrorCode.E_NOT_FOUND,
  EACCES: ErrorCode.E_PERMISSION_DENIED,
  EPERM: ErrorCode.E_PERMISSION_DENIED,
  ENOTDIR: ErrorCode.E_NOT_DIRECTORY,
  EISDIR: ErrorCode.E_NOT_FILE,
  ELOOP: ErrorCode.E_SYMLINK_NOT_ALLOWED,
  ENAMETOOLONG: ErrorCode.E_INVALID_INPUT,
  ETIMEDOUT: ErrorCode.E_TIMEOUT,
  EMFILE: ErrorCode.E_TIMEOUT,
  ENFILE: ErrorCode.E_TIMEOUT,
  EBUSY: ErrorCode.E_PERMISSION_DENIED,
  ENOTEMPTY: ErrorCode.E_NOT_DIRECTORY,
  EEXIST: ErrorCode.E_INVALID_INPUT,
  EINVAL: ErrorCode.E_INVALID_INPUT,
} as const;

export class McpError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public path?: string,
    public details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'McpError';
    Object.setPrototypeOf(this, McpError.prototype);
  }

  static fromError(
    code: ErrorCode,
    message: string,
    originalError: unknown,
    path?: string,
    details?: Record<string, unknown>
  ): McpError {
    const mcpError = new McpError(code, message, path, details, originalError);
    if (originalError instanceof Error && originalError.stack) {
      mcpError.stack = `${String(mcpError.stack)}\nCaused by: ${originalError.stack}`;
    }
    return mcpError;
  }
}

const ERROR_SUGGESTIONS: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.E_ACCESS_DENIED]:
    'Check that the path is within an allowed directory. Use list_allowed_directories to see available paths.',
  [ErrorCode.E_NOT_FOUND]:
    'Verify the path exists. Use list_directory to explore available files and directories.',
  [ErrorCode.E_NOT_FILE]:
    'The path points to a directory or other non-file. Use list_directory to explore its contents.',
  [ErrorCode.E_NOT_DIRECTORY]:
    'The path points to a file, not a directory. Use read_file to read file contents.',
  [ErrorCode.E_TOO_LARGE]:
    'The file exceeds the size limit. Use head or tail parameters to read partial content, or increase maxSize.',
  [ErrorCode.E_TIMEOUT]:
    'The operation timed out. Try with a smaller scope, fewer files, or increase timeoutMs.',
  [ErrorCode.E_INVALID_PATTERN]:
    'The glob or regex pattern is invalid. Check syntax and escape special characters.',
  [ErrorCode.E_INVALID_INPUT]:
    'One or more input parameters are invalid. Check the tool documentation for correct usage.',
  [ErrorCode.E_PERMISSION_DENIED]:
    'Permission denied by the operating system. Check file permissions.',
  [ErrorCode.E_SYMLINK_NOT_ALLOWED]:
    'Symbolic links that escape allowed directories are not permitted for security reasons.',
  [ErrorCode.E_UNKNOWN]:
    'An unexpected error occurred. Check the error message for details.',
} as const;

function getDirectErrorCode(error: unknown): ErrorCode | undefined {
  if (error instanceof McpError) {
    return error.code;
  }
  if (isNodeError(error) && error.code) {
    return NODE_ERROR_CODE_MAP[error.code];
  }
  return undefined;
}

function classifyMessageError(error: unknown): ErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('enoent')) {
    return ErrorCode.E_NOT_FOUND;
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('timed out') || message.includes('timeout');
}

export function classifyError(error: unknown): ErrorCode {
  if (isTimeoutError(error)) {
    return ErrorCode.E_TIMEOUT;
  }
  const direct = getDirectErrorCode(error);
  if (direct) return direct;

  const messageCode = classifyMessageError(error);
  return messageCode ?? ErrorCode.E_UNKNOWN;
}

export function createDetailedError(
  error: unknown,
  path?: string,
  additionalDetails?: Record<string, unknown>
): DetailedError {
  const message = error instanceof Error ? error.message : String(error);
  const code = classifyError(error);
  const suggestion = ERROR_SUGGESTIONS[code];

  return {
    code,
    message,
    path: resolveErrorPath(error, path),
    suggestion,
    details: mergeErrorDetails(error, additionalDetails),
  };
}

function resolveErrorPath(error: unknown, path?: string): string | undefined {
  if (path) return path;
  if (error instanceof McpError) return error.path;
  return undefined;
}

function mergeErrorDetails(
  error: unknown,
  additionalDetails?: Record<string, unknown>
): Record<string, unknown> | undefined {
  const mcpDetails = error instanceof McpError ? error.details : undefined;
  const mergedDetails: Record<string, unknown> = {
    ...mcpDetails,
    ...additionalDetails,
  };
  if (Object.keys(mergedDetails).length === 0) return undefined;
  return mergedDetails;
}

export function formatDetailedError(error: DetailedError): string {
  const lines: string[] = [`Error [${error.code}]: ${error.message}`];

  if (error.path) {
    lines.push(`Path: ${error.path}`);
  }

  if (error.suggestion) {
    lines.push(`Suggestion: ${error.suggestion}`);
  }

  return joinLines(lines);
}

export function getSuggestion(code: ErrorCode): string {
  return ERROR_SUGGESTIONS[code];
}
