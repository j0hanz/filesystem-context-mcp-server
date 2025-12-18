import {
  type DetailedError,
  ErrorCode,
  type ErrorResponse,
} from '../config/types.js';

export { ErrorCode };

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
  [ErrorCode.E_BINARY_FILE]:
    'This appears to be a binary file. Use read_media_file for images/audio, or set skipBinary=false to include.',
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
  [ErrorCode.E_PATH_TRAVERSAL]:
    'Path traversal attempts (../) that escape allowed directories are not permitted.',
  [ErrorCode.E_UNKNOWN]:
    'An unexpected error occurred. Check the error message for details.',
} as const;

export function classifyError(error: unknown): ErrorCode {
  if (error instanceof McpError) {
    return error.code;
  }
  if (isNodeError(error) && error.code) {
    const mapped = NODE_ERROR_CODE_MAP[error.code];
    if (mapped) return mapped;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('enoent')) {
    return validateErrorCode(ErrorCode.E_NOT_FOUND);
  }

  return classifyByMessage(error);
}

function assertNever(value: never): never {
  throw new Error(
    `Unhandled discriminated union member: ${JSON.stringify(value)}`
  );
}

function validateErrorCode(code: ErrorCode): ErrorCode {
  switch (code) {
    case ErrorCode.E_ACCESS_DENIED:
    case ErrorCode.E_NOT_FOUND:
    case ErrorCode.E_NOT_FILE:
    case ErrorCode.E_NOT_DIRECTORY:
    case ErrorCode.E_TOO_LARGE:
    case ErrorCode.E_BINARY_FILE:
    case ErrorCode.E_TIMEOUT:
    case ErrorCode.E_INVALID_PATTERN:
    case ErrorCode.E_INVALID_INPUT:
    case ErrorCode.E_PERMISSION_DENIED:
    case ErrorCode.E_SYMLINK_NOT_ALLOWED:
    case ErrorCode.E_PATH_TRAVERSAL:
    case ErrorCode.E_UNKNOWN:
      return code;
    default:
      return assertNever(code);
  }
}

function classifyByMessage(error: unknown): ErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes('not within allowed') ||
    lowerMessage.includes('access denied') ||
    lowerMessage.includes('outside allowed')
  ) {
    return validateErrorCode(ErrorCode.E_ACCESS_DENIED);
  }

  if (
    (lowerMessage.includes('path') ||
      lowerMessage.includes('file') ||
      lowerMessage.includes('directory')) &&
    (lowerMessage.includes('not found') ||
      lowerMessage.includes('does not exist'))
  ) {
    return validateErrorCode(ErrorCode.E_NOT_FOUND);
  }

  if (
    lowerMessage.includes('not a file') ||
    lowerMessage.includes('is a directory')
  ) {
    return validateErrorCode(ErrorCode.E_NOT_FILE);
  }
  if (lowerMessage.includes('not a directory')) {
    return validateErrorCode(ErrorCode.E_NOT_DIRECTORY);
  }

  if (lowerMessage.includes('too large') || lowerMessage.includes('exceeds')) {
    return validateErrorCode(ErrorCode.E_TOO_LARGE);
  }

  if (lowerMessage.includes('binary')) {
    return validateErrorCode(ErrorCode.E_BINARY_FILE);
  }

  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return validateErrorCode(ErrorCode.E_TIMEOUT);
  }

  if (lowerMessage.includes('invalid') && lowerMessage.includes('pattern')) {
    return validateErrorCode(ErrorCode.E_INVALID_PATTERN);
  }
  if (lowerMessage.includes('regex') || lowerMessage.includes('regexp')) {
    return validateErrorCode(ErrorCode.E_INVALID_PATTERN);
  }

  if (
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('cannot specify')
  ) {
    return validateErrorCode(ErrorCode.E_INVALID_INPUT);
  }

  if (
    lowerMessage.includes('permission denied') ||
    lowerMessage.includes('permission')
  ) {
    return validateErrorCode(ErrorCode.E_PERMISSION_DENIED);
  }

  if (lowerMessage.includes('symlink')) {
    return validateErrorCode(ErrorCode.E_SYMLINK_NOT_ALLOWED);
  }

  if (lowerMessage.includes('traversal')) {
    return validateErrorCode(ErrorCode.E_PATH_TRAVERSAL);
  }

  return validateErrorCode(ErrorCode.E_UNKNOWN);
}

export function createDetailedError(
  error: unknown,
  path?: string,
  additionalDetails?: Record<string, unknown>
): DetailedError {
  const message = error instanceof Error ? error.message : String(error);
  const code = classifyError(error);
  const suggestion = ERROR_SUGGESTIONS[code];

  const effectivePath =
    path ?? (error instanceof McpError ? error.path : undefined);

  const mcpDetails = error instanceof McpError ? error.details : undefined;
  const mergedDetails: Record<string, unknown> = {
    ...mcpDetails,
    ...additionalDetails,
  };
  const hasDetails = Object.keys(mergedDetails).length > 0;

  return {
    code,
    message,
    path: effectivePath,
    suggestion,
    details: hasDetails ? mergedDetails : undefined,
  };
}

export function formatDetailedError(error: DetailedError): string {
  const lines: string[] = [`Error [${error.code}]: ${error.message}`];

  if (error.path) {
    lines.push(`Path: ${error.path}`);
  }

  if (error.suggestion) {
    lines.push(`Suggestion: ${error.suggestion}`);
  }

  return lines.join('\n');
}

export function getSuggestion(code: ErrorCode): string {
  return ERROR_SUGGESTIONS[code];
}

export function createErrorResponse(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): ErrorResponse {
  const detailed = createDetailedError(error, path);
  const finalCode =
    detailed.code === ErrorCode.E_UNKNOWN ? defaultCode : detailed.code;
  detailed.code = finalCode;

  return {
    content: [{ type: 'text', text: formatDetailedError(detailed) }],
    structuredContent: {
      ok: false,
      error: {
        code: detailed.code,
        message: detailed.message,
        path: detailed.path,
        suggestion: detailed.suggestion,
      },
    },
    isError: true,
  };
}

export function validateMutuallyExclusive(
  options: Record<string, unknown>,
  optionNames: string[],
  context?: string
): void {
  const definedOptions = optionNames.filter(
    (name) => options[name] !== undefined
  );
  if (definedOptions.length > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Cannot specify multiple of: ${definedOptions.join(', ')}`,
      context
    );
  }
}

export function validateOptionPair(
  options: Record<string, unknown>,
  optionA: string,
  optionB: string,
  context?: string
): void {
  const hasA = options[optionA] !== undefined;
  const hasB = options[optionB] !== undefined;
  if (hasA !== hasB) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `${optionA} and ${optionB} must be specified together`,
      context
    );
  }
}
