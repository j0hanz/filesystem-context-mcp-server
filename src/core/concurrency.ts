import { PARALLEL_CONCURRENCY } from './util.js';
import { normalizeUnknownError } from './errors.js';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const UNFILLED = Symbol('UNFILLED');
type Unfilled = typeof UNFILLED;

export interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

function createParallelAbortError(): Error {
  return new DOMException('Operation aborted', 'AbortError');
}

function assertPositiveSafeIntegerOption(name: string, value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function normalizeConcurrency(concurrency: number): number {
  assertPositiveSafeIntegerOption('concurrency', concurrency);
  return concurrency;
}

export async function processInParallel<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = PARALLEL_CONCURRENCY,
  signal?: AbortSignal,
): Promise<ParallelResult<R>> {
  const itemCount = items.length;
  if (itemCount === 0) return { results: [], errors: [] };
  const effectiveConcurrency = normalizeConcurrency(concurrency);

  // Pre-allocate slots by index to guarantee input-order output.
  // Use UNFILLED sentinel to distinguish "not yet filled" from "filled with undefined".
  const resultSlots: (R | Unfilled)[] = new Array<R | Unfilled>(itemCount);
  const errors: { index: number; error: Error }[] = [];

  if (signal?.aborted) throw createParallelAbortError();

  let nextIndex = 0;

  resultSlots.fill(UNFILLED);

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      if (signal?.aborted) throw createParallelAbortError();

      const index = nextIndex;
      nextIndex += 1;

      // Safe: `index < itemCount === items.length`, so `items[index]` is defined.
      // Cast bypasses `noUncheckedIndexedAccess` widening to `T | undefined`.
      const item = items[index] as T;

      try {
        const result = await processor(item);
        if (signal?.aborted) throw createParallelAbortError();
        resultSlots[index] = result;
      } catch (error) {
        if (signal?.aborted) throw createParallelAbortError();

        errors.push({
          index,
          error: normalizeUnknownError(error),
        });
      }
    }
  };

  const workerCount = Math.min(itemCount, effectiveConcurrency);
  const workers: Promise<void>[] = new Array<Promise<void>>(workerCount);
  for (let index = 0; index < workerCount; index += 1) {
    workers[index] = next();
  }

  await Promise.allSettled(workers);

  if (signal?.aborted) throw createParallelAbortError();

  const results: R[] = [];
  for (const slot of resultSlots) {
    if (slot !== UNFILLED) {
      results.push(slot);
    }
  }
  return { results, errors };
}


/**
 * Main-thread worker pool.
 *
 * Exports shouldOffload(), runInWorker(), and shutdownWorkerPool().
 * Workers are spawned lazily using WORKER_ENTRY_URL from worker.ts, which
 * resolves to the correct .ts or .js file depending on context (tsx vs
 * compiled). The worker entry file (worker.ts) has no project imports, so
 * workers load without needing tsx's ESM hooks.
 *
 * Security note: this pool is process-global. Workers receive only the
 *   strings they need (oldStr, newStr, patchText) — never paths, session
 *   tokens, or AsyncLocalStorage state. Path validation always runs on the
 *   main thread before runInWorker is called.
 */

import { ErrorCode } from '../config.js';
import {
  WORKER_CANCEL_GRACE_MS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_OFFLOAD_THRESHOLD_BYTES,
  WORKER_POOL_MAX,
  WORKERS_DISABLED,
} from './util.js';
import { McpError } from './errors.js';

// ---- public API --------------------------------------------------------

export function shouldOffload(payloadBytes: number): boolean {
  if (WORKERS_DISABLED) return false;
  return payloadBytes >= WORKER_OFFLOAD_THRESHOLD_BYTES;
}

export interface RunInWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ---- pool internals ----------------------------------------------------

interface InflightEntry {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timeoutId?: NodeJS.Timeout;
}

interface QueuedTask {
  request: {
    id: number;
    name: WorkerTaskName;
    payload: TaskPayloadMap[WorkerTaskName];
  };
  entry: InflightEntry;
}

interface PoolWorker {
  worker: Worker;
  state: 'starting' | 'idle' | 'busy' | 'terminating';
  current?: InflightEntry;
  lastIdleAt: number;
  startedReady: boolean;
}

class FastQueue<T> {
  private items: T[] = [];
  private head = 0;

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head < this.items.length) {
      const item = this.items[this.head];
      this.items[this.head] = undefined as unknown as T;
      this.head++;
      if (this.head > 1000 && this.head * 2 >= this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
      return item;
    }
    return undefined;
  }

  get length(): number {
    return this.items.length - this.head;
  }

  remove(predicate: (item: T) => boolean): void {
    for (let i = this.head; i < this.items.length; i++) {
      const item = this.items[i];
      if (item !== undefined && predicate(item)) {
        this.items.splice(i, 1);
        return;
      }
    }
  }

  clear(): T[] {
    const remaining = this.items.slice(this.head);
    this.items = [];
    this.head = 0;
    return remaining;
  }
}

interface PoolState {
  workers: PoolWorker[];
  queue: FastQueue<QueuedTask>;
  nextId: number;
  sweepTimer?: NodeJS.Timeout | undefined;
}

const state: PoolState = {
  workers: [],
  queue: new FastQueue<QueuedTask>(),
  nextId: 1,
};

function startSweepTimerIfNeeded(): void {
  if (state.sweepTimer) return;
  state.sweepTimer = setInterval(sweepIdleWorkers, 10_000);
  state.sweepTimer.unref();
}

function stopSweepTimerIfPossible(): void {
  if (state.workers.length === 0 && state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = undefined;
  }
}

function sweepIdleWorkers(): void {
  const now = Date.now();
  for (let i = state.workers.length - 1; i >= 0; i--) {
    const pw = state.workers[i];
    if (pw?.state === 'idle' && now - pw.lastIdleAt >= WORKER_IDLE_TIMEOUT_MS) {
      retireWorker(pw);
    }
  }
  stopSweepTimerIfPossible();
}

function retireWorker(pw: PoolWorker): void {
  pw.state = 'terminating';
  const idx = state.workers.indexOf(pw);
  if (idx !== -1) {
    state.workers.splice(idx, 1);
  }
  void pw.worker.terminate();
}

function rehydrateError(err: SerializedError): Error {
  if (err.kind === 'mcp') {
    return new McpError(
      err.code,
      err.message,
      ...(err.path !== undefined ? [err.path] : [undefined]),
      ...(err.details !== undefined ? [err.details] : []),
    );
  }
  const e = new Error(err.message);
  if (err.stack) e.stack = err.stack;
  return e;
}

function handleResponse(pw: PoolWorker, response: TaskResponse): void {
  const entry = pw.current;
  if (entry?.id !== response.id) return;
  cleanupEntry(entry);
  delete pw.current;

  if (response.ok) {
    entry.resolve(response.value);
  } else {
    entry.reject(rehydrateError(response.error));
  }

  pw.state = 'idle';
  pw.lastIdleAt = Date.now();
  drainQueue();
}

function handleWorkerExit(pw: PoolWorker, code: number): void {
  const idx = state.workers.indexOf(pw);
  if (idx !== -1) {
    state.workers.splice(idx, 1);
  }
  if (pw.current) {
    cleanupEntry(pw.current);
    pw.current.reject(
      new McpError(ErrorCode.UNKNOWN, `Worker terminated unexpectedly (exit code ${String(code)})`),
    );
  }
  stopSweepTimerIfPossible();
}

function spawnWorker(): PoolWorker {
  // Use WORKER_ENTRY_URL from worker.ts so the URL resolves correctly in both
  // tsx (src/core/worker.ts) and compiled (dist/core/worker.js) contexts.
  // The worker entry file has no project imports, so it loads without tsx hooks.
  const w = new Worker(WORKER_ENTRY_URL);
  const pw: PoolWorker = {
    worker: w,
    state: 'starting',
    lastIdleAt: Date.now(),
    startedReady: false,
  };
  w.on('online', () => {
    pw.startedReady = true;
    if (pw.state === 'starting') {
      pw.state = 'idle';
      drainQueue();
    }
  });
  w.on('message', (msg: TaskResponse) => {
    handleResponse(pw, msg);
  });
  w.on('error', (err) => {
    if (pw.current) {
      cleanupEntry(pw.current);
      pw.current.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  w.on('exit', (code) => {
    handleWorkerExit(pw, code);
  });
  state.workers.push(pw);
  startSweepTimerIfNeeded();
  return pw;
}

function pickIdleWorker(): PoolWorker | undefined {
  return state.workers.find((p) => p.state === 'idle');
}

function dispatch(pw: PoolWorker, qt: QueuedTask): void {
  pw.state = 'busy';
  pw.current = qt.entry;
  pw.worker.postMessage(qt.request);
}

function drainQueue(): void {
  while (state.queue.length > 0) {
    const idle = pickIdleWorker();
    if (idle) {
      const next = state.queue.shift();
      if (next) dispatch(idle, next);
      continue;
    }
    if (state.workers.length < WORKER_POOL_MAX) {
      spawnWorker(); // becomes idle on 'online', re-drains then
      return;
    }
    return; // queue stays full until a worker frees up
  }
}

function cleanupEntry(entry: InflightEntry): void {
  if (entry.abortHandler && entry.signal) {
    entry.signal.removeEventListener('abort', entry.abortHandler);
  }
  if (entry.timeoutId) {
    clearTimeout(entry.timeoutId);
  }
}

// ---- public exports ----------------------------------------------------

export function runInWorker<N extends WorkerTaskName>(
  name: N,
  payload: TaskPayloadMap[N],
  opts: RunInWorkerOptions = {},
): Promise<TaskResultMap[N]> {
  if (WORKERS_DISABLED) {
    return Promise.reject(
      new McpError(ErrorCode.UNKNOWN, 'runInWorker called while FS_DISABLE_WORKERS=1 — caller bug'),
    );
  }

  return new Promise<TaskResultMap[N]>((resolve, reject) => {
    const id = state.nextId++;
    const entry: InflightEntry = {
      id,
      resolve: resolve as (v: unknown) => void,
      reject,
    };

    if (opts.signal) {
      entry.signal = opts.signal;
      const handler = (): void => {
        cleanupEntry(entry);
        const pw = state.workers.find((p) => p.current === entry);
        if (pw) {
          setTimeout(() => {
            if (state.workers.includes(pw) && pw.current === entry) retireWorker(pw);
          }, WORKER_CANCEL_GRACE_MS).unref();
        } else {
          // still queued; remove from queue
          state.queue.remove((q) => q.entry === entry);
        }
        const reason: unknown = opts.signal?.reason;
        reject(
          reason instanceof Error ? reason : new DOMException('Operation aborted', 'AbortError'),
        );
      };
      entry.abortHandler = handler;
      if (opts.signal.aborted) {
        handler();
        return;
      }
      opts.signal.addEventListener('abort', handler, { once: true });
    }

    if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
      const tid = setTimeout(() => {
        cleanupEntry(entry);
        const pw = state.workers.find((p) => p.current === entry);
        if (pw) {
          retireWorker(pw);
        } else {
          state.queue.remove((q) => q.entry === entry);
        }
        reject(new McpError(ErrorCode.TIMEOUT, 'Worker task timed out'));
      }, opts.timeoutMs);
      tid.unref();
      entry.timeoutId = tid;
    }

    state.queue.push({
      request: { id, name, payload },
      entry,
    });
    drainQueue();
  });
}

export async function shutdownWorkerPool(): Promise<void> {
  // Reject everything that's still queued.
  for (const qt of state.queue.clear()) {
    cleanupEntry(qt.entry);
    qt.entry.reject(new McpError(ErrorCode.UNKNOWN, 'Worker pool shutting down'));
  }
  // Reject in-flight tasks; terminate workers.
  const toTerminate = [...state.workers];
  state.workers = [];
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = undefined;
  }
  await Promise.all(
    toTerminate.map(async (pw) => {
      if (pw.current) {
        cleanupEntry(pw.current);
        pw.current.reject(new McpError(ErrorCode.UNKNOWN, 'Worker pool shutting down'));
      }
      try {
        await pw.worker.terminate();
      } catch {
        /* ignore */
      }
    }),
  );
}


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

import {
  applyPatch,
  createTwoFilesPatch,
  formatPatch,
  parsePatch,
  structuredPatch,
  type StructuredPatch,
} from 'diff';

/** URL of this file — used by worker-pool.ts to spawn worker threads. */
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


function createAbortError(message = 'Operation aborted'): Error {
  return new DOMException(message, 'AbortError');
}

const SHARED_NOOP_SIGNAL = new AbortController().signal;

function normalizeAbortReason(reason: unknown, message?: string): Error {
  if (reason instanceof Error) return reason;
  return createAbortError(message);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function assertNotAborted(signal?: AbortSignal, message?: string): void {
  if (!signal) return;
  try {
    signal.throwIfAborted();
  } catch (reason) {
    throw normalizeAbortReason(reason, message);
  }
}

function getAbortError(signal: AbortSignal, message?: string): Error {
  try {
    signal.throwIfAborted();
  } catch (reason) {
    return normalizeAbortReason(reason, message);
  }
  return createAbortError(message);
}

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(getAbortError(signal));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(normalizeUnknownError(error));
      },
    );
  });
}

export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number,
): { signal: AbortSignal; cleanup: () => void } {
  if (isFiniteNumber(timeoutMs)) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
    timer.unref();

    const combined = baseSignal
      ? AbortSignal.any([baseSignal, controller.signal])
      : controller.signal;

    return {
      signal: combined,
      cleanup: () => {
        clearTimeout(timer);
      },
    };
  }

  if (baseSignal) {
    return { signal: baseSignal, cleanup: () => undefined };
  }

  return { signal: SHARED_NOOP_SIGNAL, cleanup: () => undefined };
}

export async function withTimedAbortSignal<T>(
  baseSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { signal, cleanup } = createTimedAbortSignal(baseSignal, timeoutMs);
  try {
    return await run(signal);
  } finally {
    cleanup();
  }
}

