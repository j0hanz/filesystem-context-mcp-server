import { Worker } from 'node:worker_threads';

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
import { FsError, normalizeUnknownError } from './errors.js';
import {
  PARALLEL_CONCURRENCY,
  WORKER_CANCEL_GRACE_MS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_OFFLOAD_THRESHOLD_BYTES,
  WORKER_POOL_MAX,
  WORKER_QUEUE_MAX,
  WORKERS_DISABLED,
} from './util.js';
import { WORKER_ENTRY_URL } from './worker.js';
import type {
  SerializedError,
  TaskPayload,
  TaskResponse,
  TaskResult,
  WorkerTaskName,
} from './worker.js';

const UNFILLED = Symbol('UNFILLED');
type Unfilled = typeof UNFILLED;

export interface ParallelResult<R> {
  results: R[];
  errors: { index: number; error: Error }[];
}

function createParallelAbortError(): Error {
  return new DOMException('Operation aborted', 'AbortError');
}

function checkParallelAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw createParallelAbortError();
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

  checkParallelAbort(signal);

  let nextIndex = 0;

  resultSlots.fill(UNFILLED);

  const next = async (): Promise<void> => {
    while (nextIndex < itemCount) {
      checkParallelAbort(signal);

      const index = nextIndex;
      nextIndex += 1;

      // Safe: `index < itemCount === items.length`, so `items[index]` is defined.
      // Cast bypasses `noUncheckedIndexedAccess` widening to `T | undefined`.
      const item = items[index] as T;

      try {
        const result = await processor(item);
        checkParallelAbort(signal);
        resultSlots[index] = result;
      } catch (error) {
        checkParallelAbort(signal);
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

  checkParallelAbort(signal);

  const results: R[] = [];
  for (const slot of resultSlots) {
    if (slot !== UNFILLED) {
      results.push(slot);
    }
  }
  return { results, errors };
}

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
    payload: TaskPayload<WorkerTaskName>;
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
  private items: (T | undefined)[] = [];
  private head = 0;

  push(item: T): void {
    this.items.push(item);
  }

  shift(): T | undefined {
    if (this.head < this.items.length) {
      const item = this.items[this.head];
      this.items[this.head] = undefined;
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
    const remaining = this.items.slice(this.head).filter((x): x is T => x !== undefined);
    this.items = [];
    this.head = 0;
    return remaining;
  }
}

class WorkerPool {
  private workers: PoolWorker[] = [];
  private queue = new FastQueue<QueuedTask>();
  private nextId = 1;
  private sweepTimer?: NodeJS.Timeout | undefined;

  public run<N extends WorkerTaskName>(
    name: N,
    payload: TaskPayload<N>,
    opts: RunInWorkerOptions = {},
  ): Promise<TaskResult<N>> {
    if (WORKERS_DISABLED) {
      return Promise.reject(
        new FsError(
          ErrorCode.UNKNOWN,
          'runInWorker called while FS_DISABLE_WORKERS=1 — caller bug',
        ),
      );
    }

    return new Promise<TaskResult<N>>((resolve, reject) => {
      const id = this.nextId++;
      const entry: InflightEntry = {
        id,
        resolve: resolve as (v: unknown) => void,
        reject,
      };

      if (opts.signal) {
        entry.signal = opts.signal;
        const handler = (): void => {
          this.abortEntry(entry, false);
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
          this.abortEntry(entry, true);
          reject(new FsError(ErrorCode.TIMEOUT, 'Worker task timed out'));
        }, opts.timeoutMs);
        tid.unref();
        entry.timeoutId = tid;
      }

      // Reject immediately if queue is at capacity to prevent unbounded growth.
      if (this.queue.length >= WORKER_QUEUE_MAX) {
        this.cleanupEntry(entry);
        reject(
          new FsError(
            ErrorCode.UNKNOWN,
            `Worker pool task queue is full (${String(WORKER_QUEUE_MAX)} pending tasks); rejecting new submission`,
          ),
        );
        return;
      }

      this.queue.push({
        request: { id, name, payload },
        entry,
      });
      this.drainQueue();
    });
  }

  public async shutdown(): Promise<void> {
    // Reject everything that's still queued.
    for (const qt of this.queue.clear()) {
      this.cleanupEntry(qt.entry);
      qt.entry.reject(new FsError(ErrorCode.UNKNOWN, 'Worker pool shutting down'));
    }
    // Reject in-flight tasks; terminate workers.
    const toTerminate = [...this.workers];
    this.workers = [];
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await Promise.all(
      toTerminate.map(async (pw) => {
        if (pw.current) {
          this.cleanupEntry(pw.current);
          pw.current.reject(new FsError(ErrorCode.UNKNOWN, 'Worker pool shutting down'));
        }
        try {
          await pw.worker.terminate();
        } catch {
          /* ignore */
        }
      }),
    );
  }

  private startSweepTimerIfNeeded(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepIdleWorkers();
    }, 10_000);
    this.sweepTimer.unref();
  }

  private stopSweepTimerIfPossible(): void {
    if (this.workers.length === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private sweepIdleWorkers(): void {
    const now = Date.now();
    for (let i = this.workers.length - 1; i >= 0; i--) {
      const pw = this.workers[i];
      if (pw?.state === 'idle' && now - pw.lastIdleAt >= WORKER_IDLE_TIMEOUT_MS) {
        this.retireWorker(pw);
      }
    }
    this.stopSweepTimerIfPossible();
  }

  private removeWorker(pw: PoolWorker): void {
    const idx = this.workers.indexOf(pw);
    if (idx !== -1) {
      this.workers.splice(idx, 1);
    }
  }

  private retireWorker(pw: PoolWorker): void {
    pw.state = 'terminating';
    this.removeWorker(pw);
    void pw.worker.terminate();
  }

  private handleResponse(pw: PoolWorker, response: TaskResponse): void {
    const entry = pw.current;
    if (entry?.id !== response.id) return;
    this.cleanupEntry(entry);
    delete pw.current;

    if (response.ok) {
      entry.resolve(response.value);
    } else {
      entry.reject(this.rehydrateError(response.error));
    }

    pw.state = 'idle';
    pw.lastIdleAt = Date.now();
    this.drainQueue();
  }

  private handleWorkerExit(pw: PoolWorker, code: number): void {
    this.removeWorker(pw);
    if (pw.current) {
      this.cleanupEntry(pw.current);
      pw.current.reject(
        new FsError(
          ErrorCode.UNKNOWN,
          `Worker terminated unexpectedly (exit code ${String(code)})`,
        ),
      );
    }
    this.stopSweepTimerIfPossible();
    // Resume queue scheduling after worker removal, in case tasks were queued
    // while the pool was at capacity.
    this.drainQueue();
  }

  private spawnWorker(): PoolWorker {
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
        this.drainQueue();
      }
    });
    w.on('message', (msg: TaskResponse) => {
      this.handleResponse(pw, msg);
    });
    w.on('error', (err) => {
      this.handleWorkerError(pw, err);
    });
    w.on('exit', (code) => {
      this.handleWorkerExit(pw, code);
    });
    this.workers.push(pw);
    this.startSweepTimerIfNeeded();
    return pw;
  }

  private pickIdleWorker(): PoolWorker | undefined {
    return this.workers.find((p) => p.state === 'idle');
  }

  private dispatch(pw: PoolWorker, qt: QueuedTask): void {
    pw.state = 'busy';
    pw.current = qt.entry;
    pw.worker.postMessage(qt.request);
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const idle = this.pickIdleWorker();
      if (idle) {
        const next = this.queue.shift();
        if (next) this.dispatch(idle, next);
        continue;
      }
      if (this.workers.length < WORKER_POOL_MAX) {
        this.spawnWorker();
        return;
      }
      return;
    }
  }

  private findWorkerForEntry(entry: InflightEntry): PoolWorker | undefined {
    return this.workers.find((p) => p.current === entry);
  }

  private abortEntry(entry: InflightEntry, isTimeout: boolean): void {
    this.cleanupEntry(entry);
    const pw = this.findWorkerForEntry(entry);
    if (pw) {
      if (isTimeout) {
        this.retireWorker(pw);
      } else {
        setTimeout(() => {
          if (this.workers.includes(pw) && pw.current === entry) this.retireWorker(pw);
        }, WORKER_CANCEL_GRACE_MS).unref();
      }
    } else {
      this.queue.remove((q) => q.entry === entry);
    }
  }

  private handleWorkerError(pw: PoolWorker, err: unknown): void {
    if (pw.current) {
      this.cleanupEntry(pw.current);
      pw.current.reject(err instanceof Error ? err : new Error(String(err)));
      delete pw.current;
    }
    // Retire the worker to prevent further task scheduling on it.
    this.retireWorker(pw);
    // Resume queue scheduling in case tasks were queued while at capacity.
    this.drainQueue();
  }

  private cleanupEntry(entry: InflightEntry): void {
    if (entry.abortHandler && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
    }
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
    }
  }

  private rehydrateError(err: SerializedError): Error {
    if (err.kind === 'mcp') {
      return new FsError(
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
}

const globalWorkerPool = new WorkerPool();

export function runInWorker<N extends WorkerTaskName>(
  name: N,
  payload: TaskPayload<N>,
  opts: RunInWorkerOptions = {},
): Promise<TaskResult<N>> {
  return globalWorkerPool.run(name, payload, opts);
}

export async function shutdownWorkerPool(): Promise<void> {
  return globalWorkerPool.shutdown();
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
