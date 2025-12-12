import {
  type DetailedError,
  ErrorCode,
  type ErrorResponse,
} from '../config/types.js';

// Re-export ErrorCode from centralized location
export { ErrorCode };

// Type guard for Node.js ErrnoException
export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
  );
}

// Mapping of Node.js error codes to McpError codes
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

// Custom error class for MCP operations
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
    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, McpError.prototype);
  }

  // Create McpError from existing error
  static fromError(
    code: ErrorCode,
    message: string,
    originalError: unknown,
    path?: string,
    details?: Record<string, unknown>
  ): McpError {
    const mcpError = new McpError(code, message, path, details, originalError);
    // Preserve stack trace if available
    if (originalError instanceof Error && originalError.stack) {
      mcpError.stack = `${String(mcpError.stack)}\nCaused by: ${originalError.stack}`;
    }
    return mcpError;
  }
}

// Error code to suggestion mapping
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

// Classify an unknown error into a standardized ErrorCode
export function classifyError(error: unknown): ErrorCode {
  // 1. Direct McpError classification
  if (error instanceof McpError) {
    return error.code;
  }
  // 2. Node.js ErrnoException code mapping
  if (isNodeError(error) && error.code) {
    const mapped = NODE_ERROR_CODE_MAP[error.code];
    if (mapped) return mapped;
  }

  // 3. Message pattern matching (fallback for non-Node errors)
  return classifyByMessage(error);
}

// Assertion function for exhaustive checks
function assertNever(value: never): never {
  throw new Error(
    `Unhandled discriminated union member: ${JSON.stringify(value)}`
  );
}

// Validate ErrorCode exhaustiveness at compile time
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

  // Access/security related
  if (
    lowerMessage.includes('not within allowed') ||
    lowerMessage.includes('access denied') ||
    lowerMessage.includes('outside allowed')
  ) {
    return validateErrorCode(ErrorCode.E_ACCESS_DENIED);
  }

  // Not found (including ENOENT message patterns)
  if (
    lowerMessage.includes('not found') ||
    lowerMessage.includes('does not exist') ||
    lowerMessage.includes('enoent')
  ) {
    return validateErrorCode(ErrorCode.E_NOT_FOUND);
  }

  // Type mismatches
  if (
    lowerMessage.includes('not a file') ||
    lowerMessage.includes('is a directory')
  ) {
    return validateErrorCode(ErrorCode.E_NOT_FILE);
  }
  if (lowerMessage.includes('not a directory')) {
    return validateErrorCode(ErrorCode.E_NOT_DIRECTORY);
  }

  // Size limits
  if (lowerMessage.includes('too large') || lowerMessage.includes('exceeds')) {
    return validateErrorCode(ErrorCode.E_TOO_LARGE);
  }

  // Binary file
  if (lowerMessage.includes('binary')) {
    return validateErrorCode(ErrorCode.E_BINARY_FILE);
  }

  // Timeout
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return validateErrorCode(ErrorCode.E_TIMEOUT);
  }

  // Invalid pattern
  if (lowerMessage.includes('invalid') && lowerMessage.includes('pattern')) {
    return validateErrorCode(ErrorCode.E_INVALID_PATTERN);
  }
  if (lowerMessage.includes('regex') || lowerMessage.includes('regexp')) {
    return validateErrorCode(ErrorCode.E_INVALID_PATTERN);
  }

  // Invalid input
  if (
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('cannot specify')
  ) {
    return validateErrorCode(ErrorCode.E_INVALID_INPUT);
  }

  // Permission (when no error code available)
  if (
    lowerMessage.includes('permission denied') ||
    lowerMessage.includes('permission')
  ) {
    return validateErrorCode(ErrorCode.E_PERMISSION_DENIED);
  }

  // Symlink
  if (lowerMessage.includes('symlink')) {
    return validateErrorCode(ErrorCode.E_SYMLINK_NOT_ALLOWED);
  }

  // Path traversal
  if (lowerMessage.includes('traversal')) {
    return validateErrorCode(ErrorCode.E_PATH_TRAVERSAL);
  }

  return validateErrorCode(ErrorCode.E_UNKNOWN);
}

// Create detailed error with suggestions
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

  // Merge details from McpError and additionalDetails
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

// Format error for display
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

// Create MCP-compatible error response
export function createErrorResponse(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): ErrorResponse {
  const detailed = createDetailedError(error, path);
  // Use more specific code if classified, otherwise use default
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
