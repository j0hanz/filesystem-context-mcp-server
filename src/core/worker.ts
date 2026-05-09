/**
 * Worker-thread entry point and shared types.
 *
 * This file is loaded as a Worker thread entry by the main-thread worker pool
 * in `concurrency.ts`. It MUST NOT import from project TypeScript files (only
 * npm packages + built-ins) because tsx's module.register() hooks are async
 * and not active during the worker's static import phase. Only `import type`
 * (erased at runtime) is allowed for project types.
 *
 * Worker-thread side: dispatch loop. Receives { id, name, payload }, runs the
 *   matching handler from the diff package, posts back { id, ok, value } or
 *   { id, ok: false, error }. No I/O, no path validation, no allowed-
 *   directories state — those stay on the main thread.
 *
 * Security note: workers receive only the strings they need (oldStr, newStr,
 *   patchText) — never paths, session tokens, or AsyncLocalStorage state.
 *   Path validation always runs on the main thread before runInWorker is
 *   called.
 */
import { isMainThread, parentPort } from 'node:worker_threads';

import {
  applyPatch,
  createTwoFilesPatch,
  formatPatch,
  parsePatch,
  structuredPatch,
  type StructuredPatch,
} from 'diff';

import type { ErrorCode } from '../config.js';

/** URL of this file — used by the main-thread worker pool to spawn workers. */
export const WORKER_ENTRY_URL = new URL(import.meta.url);

// ---- shared types (used by both sides) ---------------------------------

export type WorkerTaskName = 'diff' | 'formatPatch' | 'applyPatch' | 'createPatch';

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

export interface CreatePatchPayload {
  oldStr: string;
  newStr: string;
  oldHeader: string;
  newHeader: string;
}

export interface TaskPayloadMap {
  diff: DiffPayload;
  formatPatch: FormatPatchPayload;
  applyPatch: ApplyPatchPayload;
  createPatch: CreatePatchPayload;
}

export interface ApplyPatchResult {
  applied: string | false;
  patch: StructuredPatch | null;
}

export interface TaskResultMap {
  diff: StructuredPatch;
  formatPatch: string;
  applyPatch: ApplyPatchResult;
  createPatch: string;
}

export interface TaskRequest {
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
      ...(e.details !== undefined ? { details: e.details } : {}),
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

const TASK_HANDLERS: {
  [K in WorkerTaskName]: (payload: TaskPayloadMap[K]) => TaskResultMap[K];
} = {
  diff: (p) =>
    structuredPatch(p.oldHeader, p.newHeader, p.oldStr, p.newStr, '', '', {
      ...(p.context !== undefined ? { context: p.context } : {}),
      ...(p.ignoreWhitespace ? { ignoreWhitespace: p.ignoreWhitespace } : {}),
      ...(p.stripTrailingCr ? { stripTrailingCr: p.stripTrailingCr } : {}),
    }),
  formatPatch: (p) => formatPatch(p.patch),
  applyPatch: (p) => {
    const parsed = parsePatch(p.patchText);
    const patch = parsed[0] ?? null;
    const applied =
      patch === null
        ? false
        : applyPatch(p.source, patch, {
            ...(p.fuzzFactor !== undefined ? { fuzzFactor: p.fuzzFactor } : {}),
            ...(p.autoConvertLineEndings !== undefined
              ? { autoConvertLineEndings: p.autoConvertLineEndings }
              : {}),
          });
    return { applied, patch };
  },
  createPatch: (p) => {
    return createTwoFilesPatch(p.oldHeader, p.newHeader, p.oldStr, p.newStr, '', '');
  },
};

function runHandler<N extends WorkerTaskName>(
  name: N,
  payload: TaskPayloadMap[N],
): TaskResultMap[N] {
  if (!Object.hasOwn(TASK_HANDLERS, name)) {
    throw new Error(`Unknown worker task: ${name as string}`);
  }
  const handler = TASK_HANDLERS[name] as (p: TaskPayloadMap[N]) => TaskResultMap[N];
  return handler(payload);
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
