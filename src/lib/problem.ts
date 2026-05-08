import { ErrorCode } from '../config.js';

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
  opts: ProblemFactoryOptions = {},
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

// Stub: real classifier comes in Task 2.
export function classify(error: unknown): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (!(error instanceof Error)) {
    return Problem.unknown(typeof error === 'string' ? error : '[non-Error thrown]');
  }
  return Problem.ioError(error.message);
}
