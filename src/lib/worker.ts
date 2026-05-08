/**
 * Single-file worker offload primitive.
 *
 * Main-thread side: lazy WorkerPool, threshold gate, abort handling, error
 *   rehydration. Used by tools that hand large diff/patch payloads to a
 *   worker via runInWorker().
 *
 * Worker-thread side: dispatch loop. Receives { id, name, payload }, runs
 *   the matching handler from the diff package, posts back { id, ok, value }
 *   or { id, ok: false, error }. No I/O, no path validation, no allowed-
 *   directories state — those stay on the main thread.
 *
 * Security note: this pool is process-global. Workers receive only the
 *   strings they need (oldStr, newStr, patchText) — never paths, session
 *   tokens, or AsyncLocalStorage state. Path validation always runs on the
 *   main thread before runInWorker is called.
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
}

export interface FormatPatchPayload {
  patch: StructuredPatch;
}

export interface ApplyPatchPayload {
  source: string;
  patchText: string;
  fuzzFactor?: number;
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

interface SerializedMcpError {
  kind: 'mcp';
  code: ErrorCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

interface SerializedGenericError {
  kind: 'generic';
  message: string;
  stack?: string;
}

type SerializedError = SerializedMcpError | SerializedGenericError;

interface TaskResponseSuccess {
  id: number;
  ok: true;
  value: TaskResultMap[WorkerTaskName];
}

interface TaskResponseFailure {
  id: number;
  ok: false;
  error: SerializedError;
}

type TaskResponse = TaskResponseSuccess | TaskResponseFailure;

// ---- worker-side: dispatch loop ----------------------------------------

function isMcpErrorLike(
  e: unknown
): e is {
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
        p.context !== undefined ? { context: p.context } : undefined
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
          : applyPatch(
              p.source,
              patch,
              p.fuzzFactor !== undefined ? { fuzzFactor: p.fuzzFactor } : {}
            );
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

// ---- main-side exports (placeholder; pool added in Task 3) -------------

// Intentionally empty in this task. Task 3 fills in shouldOffload(),
// runInWorker(), and shutdownWorkerPool().
