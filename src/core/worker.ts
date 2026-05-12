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
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import {
  applyPatch,
  createTwoFilesPatch,
  diffLines,
  formatPatch,
  parsePatch,
  structuredPatch,
  type StructuredPatch,
} from 'diff';

import type { ErrorCode } from '../config.js';

/** URL of this file — used by the main-thread worker pool to spawn workers. */
export const WORKER_ENTRY_URL = new URL(import.meta.url);

// ---- shared types (used by both sides) ---------------------------------

const WORKER_TASK_NAMES = [
  'diff',
  'formatPatch',
  'applyPatch',
  'createPatch',
  'computeDiffStats',
] as const;

export type WorkerTaskName = (typeof WORKER_TASK_NAMES)[number];

export { WORKER_TASK_NAMES };

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

export interface ComputeDiffStatsPayload {
  oldStr: string;
  newStr: string;
}

export interface ApplyPatchResult {
  applied: string | false;
  patch: StructuredPatch | null;
}

/**
 * Unified registry of all worker task types.
 * Maps task name → { payload type, result type }
 */
export interface WorkerTaskRegistry {
  diff: { payload: DiffPayload; result: StructuredPatch };
  formatPatch: { payload: FormatPatchPayload; result: string };
  applyPatch: { payload: ApplyPatchPayload; result: ApplyPatchResult };
  createPatch: { payload: CreatePatchPayload; result: string };
  computeDiffStats: {
    payload: ComputeDiffStatsPayload;
    result: { linesAdded: number; linesRemoved: number };
  };
}

/** Extract payload type for a worker task by name. */
export type TaskPayload<T extends WorkerTaskName> = WorkerTaskRegistry[T]['payload'];

/** Extract result type for a worker task by name. */
export type TaskResult<T extends WorkerTaskName> = WorkerTaskRegistry[T]['result'];

export interface TaskRequest {
  id: number;
  name: WorkerTaskName;
  payload: TaskPayload<WorkerTaskName>;
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
  value: TaskResult<WorkerTaskName>;
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
  [K in WorkerTaskName]: (payload: TaskPayload<K>) => TaskResult<K>;
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
  computeDiffStats: (p) => {
    const changes = diffLines(p.oldStr, p.newStr);
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const part of changes) {
      if (part.added) linesAdded += part.count;
      else if (part.removed) linesRemoved += part.count;
    }
    return { linesAdded, linesRemoved };
  },
};

function runHandler<N extends WorkerTaskName>(name: N, payload: TaskPayload<N>): TaskResult<N> {
  if (!Object.hasOwn(TASK_HANDLERS, name)) {
    throw new Error(`Unknown worker task: ${name as string}`);
  }
  const handler = TASK_HANDLERS[name] as (p: TaskPayload<N>) => TaskResult<N>;
  return handler(payload);
}

// Only register as the diff/patch/hash message handler when this file is the
// actual worker entry point (spawned with no workerData). Search-content workers
// pass workerData={{ debug: boolean }} and transitively import this module, so we
// must NOT register our handler in that case to avoid conflicting listeners.
if (!isMainThread && parentPort && workerData == null) {
  const port = parentPort;
  port.on('message', (msg: unknown) => {
    let response: TaskResponse;
    let msgId = -1; // Extract and store msgId early to ensure we always have it in catch block
    try {
      // Guard against malformed message envelope before dereferencing any fields.
      // Runtime validation is necessary because this message comes from external
      // sources and may be malformed or corrupted, even though TypeScript would
      // normally guarantee TaskRequest shape.
      if (msg === null || typeof msg !== 'object') {
        throw new Error('Worker received non-object message');
      }

      const msgObj = msg as Record<string, unknown>;
      if (typeof msgObj['id'] !== 'number') {
        throw new Error('Worker message missing or invalid id field');
      }
      // Safe to access msgId now; cache it before any other errors can occur
      msgId = msgObj['id'];

      if (typeof msgObj['name'] !== 'string') {
        throw new Error('Worker message missing or invalid name field');
      }
      if (msgObj['payload'] === null || typeof msgObj['payload'] !== 'object') {
        throw new Error('Worker message missing or invalid payload field');
      }

      // Now safely cast to TaskRequest after validation
      const taskRequest = msg as TaskRequest;
      const value = runHandler(taskRequest.name, taskRequest.payload);
      response = { id: msgId, ok: true, value };
    } catch (err: unknown) {
      // msgId is always set either from successful validation or kept as -1 fallback
      response = { id: msgId, ok: false, error: serializeError(err) };
    }
    port.postMessage(response);
  });
}
