import { ErrorCode, joinLines } from '../config.js';
import { DEFAULT_SUGGESTIONS, resolveSuggestion } from './error-suggestions.js';
import { getTraceContext } from './observability.js';
import {
  classify as classifyProblem,
  type Problem,
  type ProblemDetails,
  type ProblemIssue,
  zodErrorToProblem,
} from './problem.js';

export { ErrorCode };
// ─── Type guard helpers ───────────────────────────────────────────────────────

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

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  if (!isNativeError(error)) return false;
  if (!('code' in error)) return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string';
}

export function isAbortError(error: unknown): boolean {
  return classifyProblem(error).code === ErrorCode.CANCELLED;
}

export function isTimeoutLikeError(error: unknown): boolean {
  return classifyProblem(error).code === ErrorCode.TIMEOUT;
}

export function classifyError(error: unknown): ErrorCode {
  return classifyProblem(error).code;
}

export function getSuggestion(code: ErrorCode): string | undefined {
  return DEFAULT_SUGGESTIONS[code];
}

// ─── DetailedError (kept for existing tool-response callers) ─────────────────

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
  return error instanceof Error
    ? error
    : new Error(formatUnknownErrorMessage(error));
}

export function createDetailedError(
  error: unknown,
  path?: string,
  additionalDetails?: Record<string, unknown>
): DetailedError {
  const problem = classifyProblem(error);
  const trace = getTraceContext();
  const merged: Record<string, unknown> = {
    ...(trace ?? {}),
    ...(problem.details ?? {}),
    ...(additionalDetails ?? {}),
  };
  const resolvedPath = path ?? problem.path;
  const suggestion =
    problem.suggestion ??
    resolveSuggestion({ code: problem.code, issues: problem.issues ?? [] });

  return {
    code: problem.code,
    message: problem.message,
    ...(resolvedPath !== undefined ? { path: resolvedPath } : {}),
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(Object.keys(merged).length > 0 ? { details: merged } : {}),
    ...(problem.issues && problem.issues.length > 0
      ? { issues: problem.issues }
      : {}),
  };
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

// ─── McpError ────────────────────────────────────────────────────────────────

export class McpError extends Error {
  readonly problem: Problem;

  // Overload 1: new McpError(problem, cause?)
  constructor(problem: Problem, cause?: unknown);
  // Overload 2 (legacy): new McpError(code, message, path?, details?, cause?)
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  );
  constructor(
    arg1: Problem | ErrorCode,
    arg2?: unknown,
    arg3?: string,
    arg4?: Record<string, unknown>,
    arg5?: unknown
  ) {
    if (typeof arg1 === 'string') {
      // Legacy positional form
      const code = arg1;
      const message = (arg2 as string | undefined) ?? '';
      const path = arg3;
      const detailsArg = arg4;
      const cause = arg5;
      const trace = getTraceContext();
      const traceDetails: Partial<ProblemDetails> = {
        ...(trace?.traceparent !== undefined
          ? { traceparent: trace.traceparent }
          : {}),
        ...(trace?.tracestate !== undefined
          ? { tracestate: trace.tracestate }
          : {}),
        ...(trace?.baggage !== undefined ? { baggage: trace.baggage } : {}),
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
      // New Problem constructor form
      const problem = arg1;
      const cause = arg2;
      super(problem.message, cause === undefined ? {} : { cause });
      this.problem = problem;
    }
    this.name = 'McpError';
    Object.setPrototypeOf(this, McpError.prototype);
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

export { zodErrorToProblem };
