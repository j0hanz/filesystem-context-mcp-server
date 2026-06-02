import { z } from 'zod/v4';

import { getTraceContext } from './observability.js';

export const ErrorCode = {
  ACCESS_DENIED: 'ACCESS_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_FILE: 'NOT_FILE',
  NOT_DIRECTORY: 'NOT_DIRECTORY',
  TOO_LARGE: 'TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  INVALID_PATTERN: 'INVALID_PATTERN',
  INVALID_INPUT: 'INVALID_INPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  IO_ERROR: 'IO_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly issues?: readonly ProblemIssue[];
  readonly suggestion?: string;
  readonly details?: ProblemDetails;
}

interface ProblemIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface ProblemDetails {
  readonly 'io.opentelemetry/traceparent'?: string;
  readonly 'io.opentelemetry/tracestate'?: string;
  readonly 'io.opentelemetry/baggage'?: string;
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

function build(code: ErrorCode, message: string, opts: ProblemFactoryOptions = {}): Problem {
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
  notFound: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.NOT_FOUND, msg, o),
  invalidInput: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.INVALID_INPUT, msg, o),
  accessDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.ACCESS_DENIED, msg, o),
  permissionDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.PERMISSION_DENIED, msg, o),
  timeout: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.TIMEOUT, msg, o),
  cancelled: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.CANCELLED, msg, o),
  tooLarge: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.TOO_LARGE, msg, o),
  ioError: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.IO_ERROR, msg, o),
  validationFailed: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.VALIDATION_FAILED, msg, o),
  unknown: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.UNKNOWN, msg, o),
  fromUnknown(
    error: unknown,
    defaultCode: ErrorCode,
    path?: string,
  ): { code: ErrorCode; message: string; path?: string; suggestion?: string } {
    const detailed = createDetailedError(error, path);
    const shouldOverride =
      detailed.code === ErrorCode.UNKNOWN || detailed.code === ErrorCode.IO_ERROR;
    const code = shouldOverride ? defaultCode : detailed.code;
    const defaultSuggestion = shouldOverride ? getSuggestion(code) : undefined;
    const suggestion = defaultSuggestion ?? detailed.suggestion;
    return {
      code,
      message: detailed.message,
      ...(detailed.path !== undefined ? { path: detailed.path } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    };
  },
  toText(error: unknown, defaultCode: ErrorCode): { code: ErrorCode; text: string } {
    const resolved = Problem.fromUnknown(error, defaultCode);
    return { code: resolved.code, text: formatDetailedError(resolved) };
  },
} as const;

const DEFAULT_SUGGESTIONS: Readonly<Partial<Record<ErrorCode, string>>> = {
  [ErrorCode.ACCESS_DENIED]: 'Run roots to list allowed directories.',
  [ErrorCode.NOT_FOUND]: 'Run ls or find to verify the path.',
  [ErrorCode.NOT_FILE]: 'Target is a directory, not a file.',
  [ErrorCode.NOT_DIRECTORY]: 'Target is a file, not a directory.',
  [ErrorCode.TOO_LARGE]: 'Use head/tail or line ranges to read partially.',
  [ErrorCode.TIMEOUT]: 'Reduce scope, depth, or maxResults.',
  [ErrorCode.INVALID_PATTERN]: 'Check syntax and escape special characters.',
  [ErrorCode.PERMISSION_DENIED]: 'Check OS file permissions.',
  [ErrorCode.SYMLINK_NOT_ALLOWED]: 'Symlink escapes allowed directories.',
};

function readSuggestionMeta(schema: z.ZodType | undefined): string | undefined {
  if (schema === undefined || typeof schema !== 'object') return undefined;
  const meta = z.globalRegistry.get(schema) as { suggestion?: unknown } | undefined;
  if (meta && typeof meta.suggestion === 'string') return meta.suggestion;
  return undefined;
}

interface ZodDef {
  shape?: Record<string, z.ZodType>;
  type?: z.ZodType;
}

function getZodDef(schema: z.ZodType): ZodDef | undefined {
  if (typeof schema !== 'object') return undefined;
  if (!('_def' in schema)) return undefined;
  const def: unknown = (schema as { _def: unknown })._def;
  if (def === null || typeof def !== 'object') return undefined;
  return def;
}

function descend(schema: z.ZodType, segment: string | number): z.ZodType | undefined {
  const def = getZodDef(schema);
  if (!def) return undefined;
  if (typeof segment === 'string' && def.shape !== undefined && segment in def.shape) {
    return def.shape[segment];
  }
  if (typeof segment === 'number' && def.type !== undefined) return def.type;
  return undefined;
}

function suggestionFromIssueMeta(schema: z.ZodType, issue: ProblemIssue): string | undefined {
  let cursor: z.ZodType | undefined = schema;
  const trail: (z.ZodType | undefined)[] = [cursor];
  for (const segment of issue.path) {
    cursor = cursor ? descend(cursor, segment) : undefined;
    trail.push(cursor);
  }
  // Walk leaf → root: first .meta().suggestion wins.
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const found = readSuggestionMeta(trail[i]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function resolveSuggestion(
  p: Pick<Problem, 'code' | 'issues'>,
  schema?: z.ZodType,
): string | undefined {
  if (p.issues && p.issues.length > 0 && schema) {
    for (const issue of p.issues) {
      const fromMeta = suggestionFromIssueMeta(schema, issue);
      if (fromMeta) return fromMeta;
    }
  }
  if (p.issues && p.issues.length > 0) {
    for (const issue of p.issues) {
      const fromRule = issue.params?.['suggestion'];
      if (typeof fromRule === 'string') return fromRule;
    }
  }
  return DEFAULT_SUGGESTIONS[p.code];
}

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

function buildProblemFromSignal(signal: ClassificationSignal, error: unknown): Problem {
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
    default: {
      const _exhaustive: never = signal;
      return Problem.ioError(`Unhandled error kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function toProblemIssue(issue: z.core.$ZodIssue): ProblemIssue {
  const base: ProblemIssue = {
    path: issue.path as readonly (string | number)[],
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

export function zodErrorToProblem(err: z.ZodError, schema?: z.ZodType): Problem {
  const issues = err.issues.map(toProblemIssue);
  const suggestion = resolveSuggestion({ code: ErrorCode.VALIDATION_FAILED, issues }, schema);
  return build(ErrorCode.VALIDATION_FAILED, z.prettifyError(err), {
    issues,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}

function isFsErrorCarrier(error: unknown): error is { problem: Problem } {
  return (
    error instanceof Error &&
    error.name === 'FsError' &&
    'problem' in error &&
    typeof (error as { problem?: unknown }).problem === 'object'
  );
}

export function classify(error: unknown, ctx?: { schema?: z.ZodType }): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (isFsErrorCarrier(error)) return error.problem;
  if (error instanceof z.ZodError) return zodErrorToProblem(error, ctx?.schema);
  if (!(error instanceof Error)) {
    return Problem.unknown(typeof error === 'string' ? error : '[non-Error thrown]');
  }
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}

function isNativeError(error: unknown): error is Error {
  const candidate = Error;
  if (typeof candidate.isError === 'function') {
    return candidate.isError(error);
  }
  return error instanceof Error;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  if (!isNativeError(error)) return false;
  if (!('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string';
}

export function isAbortError(error: unknown): boolean {
  return classify(error).code === ErrorCode.CANCELLED;
}

export function isTimeoutLikeError(error: unknown): boolean {
  return classify(error).code === ErrorCode.TIMEOUT;
}

export function classifyError(error: unknown): ErrorCode {
  return classify(error).code;
}

export function getSuggestion(code: ErrorCode): string | undefined {
  return DEFAULT_SUGGESTIONS[code];
}

interface DetailedError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
  issues?: readonly ProblemIssue[];
}

export function formatUnknownErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isNativeError(error)) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error ? error : new Error(formatUnknownErrorMessage(error));
}

export function createDetailedError(
  error: unknown,
  path?: string,
  additionalDetails?: Record<string, unknown>,
): DetailedError {
  const problem = classify(error);
  const trace = getTraceContext();
  const merged: Record<string, unknown> = {
    ...(trace ?? {}),
    ...(problem.details ?? {}),
    ...(additionalDetails ?? {}),
  };
  const resolvedPath = path ?? problem.path;
  const suggestion =
    problem.suggestion ?? resolveSuggestion({ code: problem.code, issues: problem.issues ?? [] });

  return {
    code: problem.code,
    message: problem.message,
    ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(Object.keys(merged).length > 0 ? { details: merged } : {}),
    ...(problem.issues && problem.issues.length > 0 ? { issues: problem.issues } : {}),
  };
}

function formatDetailedError(error: DetailedError): string {
  const lines: string[] = [`${error.code}: ${error.message}`];
  if (error.path && !error.message.includes(error.path)) {
    lines.push(error.path);
  }
  if (error.suggestion) {
    lines.push(error.suggestion);
  }
  return joinLines(lines);
}

export class FsError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem, cause?: unknown);
  // Legacy positional form: new FsError(code, message, path?, details?, cause?)
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  );
  constructor(
    arg1: Problem | ErrorCode,
    arg2?: unknown,
    arg3?: string,
    arg4?: Record<string, unknown>,
    arg5?: unknown,
  ) {
    if (typeof arg1 === 'string') {
      const code = arg1;
      const message = (arg2 as string | undefined) ?? '';
      const path = arg3;
      const detailsArg = arg4;
      const cause = arg5;
      const trace = getTraceContext();
      const traceDetails: Partial<ProblemDetails> = {
        ...(trace?.traceparent !== undefined
          ? { 'io.opentelemetry/traceparent': trace.traceparent }
          : {}),
        ...(trace?.tracestate !== undefined
          ? { 'io.opentelemetry/tracestate': trace.tracestate }
          : {}),
        ...(trace?.baggage !== undefined ? { 'io.opentelemetry/baggage': trace.baggage } : {}),
      };

      const details: ProblemDetails | undefined =
        Object.keys(traceDetails).length > 0 || detailsArg !== undefined
          ? {
              ...traceDetails,
              ...(detailsArg !== undefined ? { extra: detailsArg } : {}),
            }
          : undefined;

      const suggestion = DEFAULT_SUGGESTIONS[code];
      const problem: Problem = {
        code,
        message,
        ...(path !== undefined ? { path } : {}),
        ...(details !== undefined ? { details } : {}),
        ...(suggestion !== undefined ? { suggestion } : {}),
      };
      super(message, cause === undefined ? {} : { cause });
      this.problem = problem;
    } else {
      const problem = arg1;
      const cause = arg2;
      super(problem.message, cause === undefined ? {} : { cause });
      this.problem = problem;
    }
    this.name = 'FsError';
    Object.setPrototypeOf(this, FsError.prototype);
  }

  get code(): ErrorCode {
    return this.problem.code;
  }

  get path(): string | undefined {
    return this.problem.path;
  }

  get details(): Record<string, unknown> | undefined {
    if (!this.problem.details) return undefined;
    const { extra, ...rest } = this.problem.details;
    if (!extra) return Object.keys(rest).length > 0 ? rest : undefined;
    return { ...rest, ...extra };
  }
}
