/**
 * Worker-thread entry point and shared types.
 *
 * This file is loaded as a Worker thread entry by worker-pool.ts. It MUST NOT
 * import from project TypeScript files (only npm packages + built-ins) because
 * tsx's module.register() hooks are async and not active during the worker's
 * static import phase. Only `import type` (erased at runtime) is allowed for
 * project types.
 *
 * Worker-thread side: dispatch loop. Receives { id, name, payload }, runs
 *   the matching handler from the diff package, posts back { id, ok, value }
 *   or { id, ok: false, error }. No I/O, no path validation, no allowed-
 *   directories state — those stay on the main thread (worker-pool.ts).
 *
 * Security note: workers receive only the strings they need (oldStr, newStr,
 *   patchText) — never paths, session tokens, or AsyncLocalStorage state.
 *   Path validation always runs on the main thread before runInWorker is
 *   called.
 */
import { isMainThread, parentPort } from 'node:worker_threads';

import {
  applyPatch,
  type Change,
  createTwoFilesPatch,
  diffLines,
  formatPatch,
  parsePatch,
  structuredPatch,
  type StructuredPatch,
} from 'diff';

import type { ErrorCode } from '../config.js';

/** URL of this file — used by worker-pool.ts to spawn worker threads. */
export const WORKER_ENTRY_URL = new URL(import.meta.url);

// ---- shared types (used by both sides) ---------------------------------

export type WorkerTaskName =
  | 'diff'
  | 'formatPatch'
  | 'applyPatch'
  | 'diffLines';

export interface DiffPayload {
  oldStr: string;
  newStr: string;
  oldHeader: string;
  newHeader: string;
  context?: number;
  ignoreWhitespace?: boolean;
  stripTrailingCr?: boolean;
}

export interface FormatPatchPayload {
  patch: StructuredPatch;
}

export interface ApplyPatchPayload {
  source: string;
  patchText: string;
  fuzzFactor?: number;
  autoConvertLineEndings?: boolean;
}

export interface DiffLinesPayload {
  oldStr: string;
  newStr: string;
  oldHeader: string;
  newHeader: string;
}

export interface TaskPayloadMap {
  diff: DiffPayload;
  formatPatch: FormatPatchPayload;
  applyPatch: ApplyPatchPayload;
  diffLines: DiffLinesPayload;
}

export interface ApplyPatchResult {
  applied: string | false;
  patch: StructuredPatch | null;
}

export interface DiffLinesResult {
  changes: Change[];
  unifiedDiff: string;
}

export interface TaskResultMap {
  diff: StructuredPatch;
  formatPatch: string;
  applyPatch: ApplyPatchResult;
  diffLines: DiffLinesResult;
}

interface TaskRequest {
  id: number;
  name: WorkerTaskName;
  payload: TaskPayloadMap[WorkerTaskName];
}

export interface SerializedMcpError {
  kind: 'mcp';
  code: ErrorCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface SerializedGenericError {
  kind: 'generic';
  message: string;
  stack?: string;
}

export type SerializedError = SerializedMcpError | SerializedGenericError;

export interface TaskResponseSuccess {
  id: number;
  ok: true;
  value: TaskResultMap[WorkerTaskName];
}

export interface TaskResponseFailure {
  id: number;
  ok: false;
  error: SerializedError;
}

export type TaskResponse = TaskResponseSuccess | TaskResponseFailure;

// ---- worker-side: dispatch loop ----------------------------------------

function isMcpErrorLike(e: unknown): e is {
  name: string;
  code: ErrorCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
} {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'McpError' &&
    typeof (e as { code?: unknown }).code === 'string'
  );
}

function serializeError(e: unknown): SerializedError {
  if (isMcpErrorLike(e)) {
    return {
      kind: 'mcp',
      code: e.code,
      message: e.message,
      ...(e.path ? { path: e.path } : {}),
      ...(e.details ? { details: e.details } : {}),
    };
  }
  if (e instanceof Error) {
    return {
      kind: 'generic',
      message: e.message,
      ...(e.stack ? { stack: e.stack } : {}),
    };
  }
  return { kind: 'generic', message: String(e) };
}

function runHandler<N extends WorkerTaskName>(
  name: N,
  payload: TaskPayloadMap[N]
): TaskResultMap[N] {
  switch (name) {
    case 'diff': {
      const p = payload as DiffPayload;
      const result = structuredPatch(
        p.oldHeader,
        p.newHeader,
        p.oldStr,
        p.newStr,
        '',
        '',
        {
          ...(p.context !== undefined ? { context: p.context } : {}),
          ...(p.ignoreWhitespace
            ? { ignoreWhitespace: p.ignoreWhitespace }
            : {}),
          ...(p.stripTrailingCr ? { stripTrailingCr: p.stripTrailingCr } : {}),
        }
      );
      return result as TaskResultMap[N];
    }
    case 'formatPatch': {
      const p = payload as FormatPatchPayload;
      return formatPatch(p.patch) as TaskResultMap[N];
    }
    case 'applyPatch': {
      const p = payload as ApplyPatchPayload;
      const parsed = parsePatch(p.patchText);
      const patch = parsed[0] ?? null;
      const applied =
        patch === null
          ? false
          : applyPatch(p.source, patch, {
              ...(p.fuzzFactor !== undefined
                ? { fuzzFactor: p.fuzzFactor }
                : {}),
              ...(p.autoConvertLineEndings !== undefined
                ? { autoConvertLineEndings: p.autoConvertLineEndings }
                : {}),
            });
      const result: ApplyPatchResult = { applied, patch };
      return result as TaskResultMap[N];
    }
    case 'diffLines': {
      const p = payload as DiffLinesPayload;
      const changes = diffLines(p.oldStr, p.newStr);
      const unifiedDiff = createTwoFilesPatch(
        p.oldHeader,
        p.newHeader,
        p.oldStr,
        p.newStr,
        '',
        ''
      );
      const result: DiffLinesResult = { changes, unifiedDiff };
      return result as TaskResultMap[N];
    }
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown worker task: ${String(exhaustive)}`);
    }
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on('message', (msg: TaskRequest) => {
    let response: TaskResponse;
    try {
      const value = runHandler(msg.name, msg.payload);
      response = { id: msg.id, ok: true, value };
    } catch (err: unknown) {
      response = { id: msg.id, ok: false, error: serializeError(err) };
    }
    port.postMessage(response);
  });
}
