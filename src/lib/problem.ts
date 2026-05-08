import { z } from 'zod/v4';

import { ErrorCode } from '../config.js';
import { resolveSuggestion } from './error-suggestions.js';

export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly issues?: readonly ProblemIssue[];
  readonly suggestion?: string;
  readonly details?: ProblemDetails;
}

export interface ProblemIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ProblemDetails {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
  readonly errno?: string;
  readonly syscall?: string;
  readonly tool?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

interface ProblemFactoryOptions {
  path?: string;
  suggestion?: string;
  details?: ProblemDetails;
  issues?: readonly ProblemIssue[];
}

function build(
  code: ErrorCode,
  message: string,
  opts: ProblemFactoryOptions = {}
): Problem {
  return {
    code,
    message,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.suggestion !== undefined ? { suggestion: opts.suggestion } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
    ...(opts.issues !== undefined ? { issues: opts.issues } : {}),
  };
}

export const Problem = {
  notFound: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.NOT_FOUND, msg, o),
  invalidInput: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.INVALID_INPUT, msg, o),
  accessDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.ACCESS_DENIED, msg, o),
  permissionDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.PERMISSION_DENIED, msg, o),
  timeout: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.TIMEOUT, msg, o),
  cancelled: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.CANCELLED, msg, o),
  tooLarge: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.TOO_LARGE, msg, o),
  ioError: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.IO_ERROR, msg, o),
  validationFailed: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.VALIDATION_FAILED, msg, o),
  unknown: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.UNKNOWN, msg, o),
} as const;

const ERRNO_MAP: Readonly<Record<string, ErrorCode>> = {
  ENOENT: ErrorCode.NOT_FOUND,
  EACCES: ErrorCode.PERMISSION_DENIED,
  EPERM: ErrorCode.PERMISSION_DENIED,
  ENOTDIR: ErrorCode.NOT_DIRECTORY,
  EISDIR: ErrorCode.NOT_FILE,
  ELOOP: ErrorCode.SYMLINK_NOT_ALLOWED,
  ENAMETOOLONG: ErrorCode.INVALID_INPUT,
  ETIMEDOUT: ErrorCode.TIMEOUT,
  EMFILE: ErrorCode.IO_ERROR,
  ENFILE: ErrorCode.IO_ERROR,
  EBUSY: ErrorCode.IO_ERROR,
  ENOTEMPTY: ErrorCode.NOT_DIRECTORY,
  EEXIST: ErrorCode.INVALID_INPUT,
  EINVAL: ErrorCode.INVALID_INPUT,
};

const ERRNO_RE = /^E[A-Z]+$/;

type ClassificationSignal =
  | { kind: 'abort' }
  | { kind: 'timeout' }
  | { kind: 'errno'; errno: string; syscall?: string; path?: string }
  | { kind: 'unknown' };

function readErrnoCode(value: unknown): string | undefined {
  if (!(value instanceof Error)) return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  return code;
}

function isAbortSingle(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'AbortError') return true;
  const code = readErrnoCode(value);
  return code === 'ABORT_ERR';
}

function isTimeoutSingle(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'TimeoutError') return true;
  return readErrnoCode(value) === 'ETIMEDOUT';
}

function readSignalSingle(value: unknown): ClassificationSignal | undefined {
  if (isAbortSingle(value)) return { kind: 'abort' };
  if (isTimeoutSingle(value)) return { kind: 'timeout' };
  const code = readErrnoCode(value);
  if (code !== undefined && ERRNO_RE.test(code)) {
    const v = value as NodeJS.ErrnoException;
    return {
      kind: 'errno',
      errno: code,
      ...(typeof v.syscall === 'string' ? { syscall: v.syscall } : {}),
      ...(typeof v.path === 'string' ? { path: v.path } : {}),
    };
  }
  return undefined;
}

function walkCauseChain(error: unknown): ClassificationSignal {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let abortSeen = false;
  let timeoutSeen = false;
  let errnoSignal: ClassificationSignal | undefined;

  while (current !== undefined && current !== null && !visited.has(current)) {
    const signal = readSignalSingle(current);
    if (signal !== undefined) {
      if (signal.kind === 'abort') abortSeen = true;
      else if (signal.kind === 'timeout') timeoutSeen = true;
      else if (signal.kind === 'errno' && errnoSignal === undefined) {
        errnoSignal = signal;
      }
    }
    if (!(current instanceof Error)) break;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  if (abortSeen) return { kind: 'abort' };
  if (timeoutSeen) return { kind: 'timeout' };
  if (errnoSignal !== undefined) return errnoSignal;
  return { kind: 'unknown' };
}

function buildProblemFromSignal(
  signal: ClassificationSignal,
  error: unknown
): Problem {
  const message = error instanceof Error ? error.message : String(error);
  switch (signal.kind) {
    case 'abort':
      return Problem.cancelled(message);
    case 'timeout':
      return Problem.timeout(message);
    case 'errno': {
      const code = ERRNO_MAP[signal.errno] ?? ErrorCode.IO_ERROR;
      const details: ProblemDetails = {
        errno: signal.errno,
        ...(signal.syscall !== undefined ? { syscall: signal.syscall } : {}),
      };
      return build(code, message, {
        ...(signal.path !== undefined ? { path: signal.path } : {}),
        details,
      });
    }
    case 'unknown':
      return Problem.ioError(message);
  }
}

function toProblemIssue(issue: z.core.$ZodIssue): ProblemIssue {
  const base: ProblemIssue = {
    path: issue.path.map(String),
    code: issue.code,
    message: issue.message,
  };
  const expected = (issue as { expected?: string }).expected;
  const received = (issue as { received?: string }).received;
  const params = (issue as { params?: unknown }).params;
  return {
    ...base,
    ...(expected !== undefined ? { expected } : {}),
    ...(received !== undefined ? { received } : {}),
    ...(params !== null && typeof params === 'object'
      ? { params: params as Record<string, unknown> }
      : {}),
  };
}

export function zodErrorToProblem(
  err: z.ZodError,
  schema?: z.ZodType
): Problem {
  const issues = err.issues.map(toProblemIssue);
  const suggestion = resolveSuggestion(
    { code: ErrorCode.VALIDATION_FAILED, issues },
    schema
  );
  return build(ErrorCode.VALIDATION_FAILED, z.prettifyError(err), {
    issues,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}

function isMcpError(error: unknown): error is { problem: Problem } {
  return (
    error instanceof Error &&
    error.name === 'McpError' &&
    'problem' in error &&
    typeof (error as { problem?: unknown }).problem === 'object'
  );
}

export function classify(
  error: unknown,
  ctx?: { schema?: z.ZodType }
): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (isMcpError(error)) return error.problem;
  if (error instanceof z.ZodError) return zodErrorToProblem(error, ctx?.schema);
  if (!(error instanceof Error)) {
    return Problem.unknown(
      typeof error === 'string' ? error : '[non-Error thrown]'
    );
  }
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}
