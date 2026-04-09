import { constants as osConstants } from 'node:os';
import { getSystemErrorMap, getSystemErrorName, inspect } from 'node:util';

import { ErrorCode, joinLines } from '../config.js';
import { getTraceContext } from './observability.js';

export { ErrorCode };

interface ErrorConstructorWithIsError extends ErrorConstructor {
  isError?: (value: unknown) => boolean;
}

function isNativeError(error: unknown): error is Error {
  const candidate = Error as ErrorConstructorWithIsError;
  if (typeof candidate.isError === 'function') {
    return candidate.isError(error);
  }
  return error instanceof Error;
}

interface DetailedError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  if (!isNativeError(error)) return false;
  if (!('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string';
}

function getNodeErrno(error: unknown): number | undefined {
  if (!isNativeError(error)) return undefined;
  if (!('errno' in error)) return undefined;
  const { errno } = error as { errno?: unknown };
  if (typeof errno !== 'number' || !Number.isInteger(errno)) return undefined;
  return errno;
}

function messageIncludesAny(
  message: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) => message.includes(pattern));
}

const ERRNO_CODE_BY_VALUE = new Map<number, string>();
const SYSTEM_ERROR_MAP = getSystemErrorMap();

for (const [name, value] of Object.entries(osConstants.errno)) {
  if (typeof value !== 'number') continue;
  if (!ERRNO_CODE_BY_VALUE.has(value)) {
    ERRNO_CODE_BY_VALUE.set(value, name);
  }
}

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]+$/u;

function getSystemErrorNameFromMap(errno: number): string | undefined {
  const direct = SYSTEM_ERROR_MAP.get(errno);
  if (direct) return direct[0];

  const normalized = SYSTEM_ERROR_MAP.get(-Math.abs(errno));
  if (normalized) return normalized[0];

  return undefined;
}

function getNodeErrorCodeFromErrno(errno: number): string | undefined {
  const direct = ERRNO_CODE_BY_VALUE.get(errno);
  if (direct) return direct;

  const normalized = ERRNO_CODE_BY_VALUE.get(Math.abs(errno));
  if (normalized) return normalized;

  const fromMap = getSystemErrorNameFromMap(errno);
  if (fromMap && ERROR_CODE_RE.test(fromMap)) return fromMap;

  try {
    const fromSystem = getSystemErrorName(errno <= 0 ? errno : -errno);
    return ERROR_CODE_RE.test(fromSystem) ? fromSystem : undefined;
  } catch {
    return undefined;
  }
}

function getNodeErrorCodeLabel(error: unknown): string | undefined {
  if (isNodeError(error)) return error.code;
  const errno = getNodeErrno(error);
  if (errno === undefined) return undefined;
  return getNodeErrorCodeFromErrno(errno);
}

export function formatUnknownErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isNativeError(error)) return error.message;
  try {
    return inspect(error, {
      depth: 3,
      colors: false,
      compact: 3,
      breakLength: 80,
      maxArrayLength: 50,
      maxStringLength: 2000,
    });
  } catch {
    return String(error);
  }
}

export function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(formatUnknownErrorMessage(error));
}

const NODE_ERROR_CODE_MAP = {
  ENOENT: ErrorCode.NOT_FOUND,
  EACCES: ErrorCode.PERMISSION_DENIED,
  EPERM: ErrorCode.PERMISSION_DENIED,
  ENOTDIR: ErrorCode.NOT_DIRECTORY,
  EISDIR: ErrorCode.NOT_FILE,
  ELOOP: ErrorCode.SYMLINK_NOT_ALLOWED,
  ENAMETOOLONG: ErrorCode.INVALID_INPUT,
  ETIMEDOUT: ErrorCode.TIMEOUT,
  EMFILE: ErrorCode.TIMEOUT,
  ENFILE: ErrorCode.TIMEOUT,
  EBUSY: ErrorCode.PERMISSION_DENIED,
  ENOTEMPTY: ErrorCode.NOT_DIRECTORY,
  EEXIST: ErrorCode.INVALID_INPUT,
  EINVAL: ErrorCode.INVALID_INPUT,
} as const satisfies Readonly<Record<string, ErrorCode>>;

type NodeErrorCode = keyof typeof NODE_ERROR_CODE_MAP;

function isKnownNodeErrorCode(code: string): code is NodeErrorCode {
  return code in NODE_ERROR_CODE_MAP;
}

function getNodeErrorCode(code: string): ErrorCode | undefined {
  return isKnownNodeErrorCode(code) ? NODE_ERROR_CODE_MAP[code] : undefined;
}

function walkErrorChain<T>(
  error: unknown,
  visitor: (value: unknown) => T | undefined
): T | undefined {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current !== undefined && current !== null && !visited.has(current)) {
    const visitedResult = visitor(current);
    if (visitedResult !== undefined) return visitedResult;
    if (!isNativeError(current)) break;

    visited.add(current);

    const next = (current as { cause?: unknown }).cause;
    current = next;
  }

  return undefined;
}

function isAbortErrorSingle(error: unknown): boolean {
  if (!isNativeError(error)) return false;
  if (error.name === 'AbortError') return true;

  const code = getNodeErrorCodeLabel(error);
  return code === 'ABORT_ERR';
}

export function isAbortError(error: unknown): boolean {
  return (
    walkErrorChain(error, (candidate) =>
      isAbortErrorSingle(candidate) ? true : undefined
    ) === true
  );
}

function isTimeoutErrorSingle(error: unknown): boolean {
  if (!isNativeError(error)) return false;
  if (error.name === 'TimeoutError') return true;

  const code = getNodeErrorCodeLabel(error);
  if (code === 'ETIMEDOUT') return true;

  const message = error.message.toLowerCase();
  return message.includes('timed out') || message.includes('timeout');
}

export function isTimeoutLikeError(error: unknown): boolean {
  return (
    walkErrorChain(error, (candidate) =>
      isTimeoutErrorSingle(candidate) ? true : undefined
    ) === true
  );
}

export class McpError extends Error {
  details?: Record<string, unknown>;

  constructor(
    public code: ErrorCode,
    message: string,
    public path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = 'McpError';
    Object.setPrototypeOf(this, McpError.prototype);

    const trace = getTraceContext();
    if (trace?.traceparent || details) {
      this.details = { ...trace, ...details };
    }
  }

  static notFound(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.NOT_FOUND, message, path, details, cause);
  }

  static invalidInput(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.INVALID_INPUT, message, path, details, cause);
  }

  static accessDenied(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.ACCESS_DENIED, message, path, details, cause);
  }

  static timeout(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.TIMEOUT, message, path, details, cause);
  }
}

const ERROR_SUGGESTIONS: Readonly<Record<ErrorCode, string | undefined>> = {
  [ErrorCode.ACCESS_DENIED]: 'Run roots to list allowed directories.',
  [ErrorCode.NOT_FOUND]: 'Run ls or find to verify the path.',
  [ErrorCode.NOT_FILE]: 'Target is a directory, not a file.',
  [ErrorCode.NOT_DIRECTORY]: 'Target is a file, not a directory.',
  [ErrorCode.TOO_LARGE]: 'Use head/tail or line ranges to read partially.',
  [ErrorCode.TIMEOUT]: 'Reduce scope, depth, or maxResults.',
  [ErrorCode.CANCELLED]: undefined,
  [ErrorCode.INVALID_PATTERN]: 'Check syntax and escape special characters.',
  [ErrorCode.INVALID_INPUT]: undefined,
  [ErrorCode.PERMISSION_DENIED]: 'Check OS file permissions.',
  [ErrorCode.SYMLINK_NOT_ALLOWED]: 'Symlink escapes allowed directories.',
  [ErrorCode.UNKNOWN]: undefined,
} as const;

const NOT_FOUND_PATTERNS = [
  'no such file or directory',
  'does not exist',
] as const;
const PERMISSION_DENIED_PATTERNS = [
  'permission denied',
  'not permitted',
] as const;

function getDirectErrorCode(error: unknown): ErrorCode | undefined {
  if (error instanceof McpError) {
    return error.code;
  }
  const code = getNodeErrorCodeLabel(error);
  return code ? getNodeErrorCode(code) : undefined;
}

function classifyMessageError(error: unknown): ErrorCode | undefined {
  const message = isNativeError(error) ? error.message : String(error);
  const lower = message.toLowerCase();
  if (messageIncludesAny(lower, NOT_FOUND_PATTERNS)) {
    return ErrorCode.NOT_FOUND;
  }
  if (messageIncludesAny(lower, PERMISSION_DENIED_PATTERNS)) {
    return ErrorCode.PERMISSION_DENIED;
  }
  if (lower.includes('not a directory')) {
    return ErrorCode.NOT_DIRECTORY;
  }
  if (lower.includes('is a directory')) {
    return ErrorCode.NOT_FILE;
  }
  return undefined;
}

function classifyError(error: unknown): ErrorCode {
  let timeoutCode: ErrorCode | undefined;
  let fallbackCode: ErrorCode | undefined;

  const terminalCode = walkErrorChain<ErrorCode>(error, (candidate) => {
    if (isAbortErrorSingle(candidate)) {
      return ErrorCode.CANCELLED;
    }

    if (timeoutCode === undefined && isTimeoutErrorSingle(candidate)) {
      timeoutCode = ErrorCode.TIMEOUT;
    }

    fallbackCode ??=
      getDirectErrorCode(candidate) ?? classifyMessageError(candidate);

    return undefined;
  });

  return terminalCode ?? timeoutCode ?? fallbackCode ?? ErrorCode.UNKNOWN;
}

export function createDetailedError(
  error: unknown,
  path?: string,
  additionalDetails?: Record<string, unknown>
): DetailedError {
  const message = formatUnknownErrorMessage(error);
  const code = classifyError(error);
  const suggestion = ERROR_SUGGESTIONS[code];
  const resolvedPath = resolveErrorPath(error, path);
  const details = mergeErrorDetails(error, additionalDetails);

  const result: DetailedError = {
    code,
    message,
    ...(suggestion ? { suggestion } : {}),
  };
  if (resolvedPath) result.path = resolvedPath;
  if (details) result.details = details;
  return result;
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
  const lines: string[] = [`${error.code}: ${error.message}`];

  if (error.path && !error.message.includes(error.path)) {
    lines.push(error.path);
  }

  if (error.suggestion) {
    lines.push(error.suggestion);
  }

  return joinLines(lines);
}

export function getSuggestion(code: ErrorCode): string | undefined {
  return ERROR_SUGGESTIONS[code];
}
