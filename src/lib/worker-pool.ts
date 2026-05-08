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
import { Worker } from 'node:worker_threads';

import { ErrorCode } from '../config.js';
import {
  WORKER_CANCEL_GRACE_MS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_OFFLOAD_THRESHOLD_BYTES,
  WORKER_POOL_MAX,
  WORKERS_DISABLED,
} from './constants.js';
import { McpError } from './errors.js';
import {
  type SerializedError,
  type TaskPayloadMap,
  type TaskResponse,
  type TaskResultMap,
  WORKER_ENTRY_URL,
  type WorkerTaskName,
} from './worker.js';

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

let pool: PoolWorker[] = [];
const queue: QueuedTask[] = [];
let nextId = 1;
let sweepTimer: NodeJS.Timeout | undefined;

function startSweepTimerIfNeeded(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdleWorkers, 10_000);
  sweepTimer.unref();
}

function stopSweepTimerIfPossible(): void {
  if (pool.length === 0 && sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

function sweepIdleWorkers(): void {
  const now = Date.now();
  for (const pw of [...pool]) {
    if (pw.state === 'idle' && now - pw.lastIdleAt >= WORKER_IDLE_TIMEOUT_MS) {
      retireWorker(pw);
    }
  }
  stopSweepTimerIfPossible();
}

function retireWorker(pw: PoolWorker): void {
  pw.state = 'terminating';
  pool = pool.filter((x) => x !== pw);
  void pw.worker.terminate();
}

function rehydrateError(err: SerializedError): Error {
  if (err.kind === 'mcp') {
    return new McpError(
      err.code,
      err.message,
      ...(err.path !== undefined ? [err.path] : [undefined]),
      ...(err.details !== undefined ? [err.details] : [])
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
  pool = pool.filter((x) => x !== pw);
  if (pw.current) {
    cleanupEntry(pw.current);
    pw.current.reject(
      new McpError(
        ErrorCode.UNKNOWN,
        `Worker terminated unexpectedly (exit code ${String(code)})`
      )
    );
  }
  stopSweepTimerIfPossible();
}

function spawnWorker(): PoolWorker {
  // Use WORKER_ENTRY_URL from worker.ts so the URL resolves correctly in both
  // tsx (src/lib/worker.ts) and compiled (dist/lib/worker.js) contexts.
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
  pool.push(pw);
  startSweepTimerIfNeeded();
  return pw;
}

function pickIdleWorker(): PoolWorker | undefined {
  return pool.find((p) => p.state === 'idle');
}

function dispatch(pw: PoolWorker, qt: QueuedTask): void {
  pw.state = 'busy';
  pw.current = qt.entry;
  pw.worker.postMessage(qt.request);
}

function drainQueue(): void {
  while (queue.length > 0) {
    const idle = pickIdleWorker();
    if (idle) {
      const next = queue.shift();
      if (next) dispatch(idle, next);
      continue;
    }
    if (pool.length < WORKER_POOL_MAX) {
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
  opts: RunInWorkerOptions = {}
): Promise<TaskResultMap[N]> {
  if (WORKERS_DISABLED) {
    return Promise.reject(
      new McpError(
        ErrorCode.UNKNOWN,
        'runInWorker called while FS_DISABLE_WORKERS=1 — caller bug'
      )
    );
  }

  return new Promise<TaskResultMap[N]>((resolve, reject) => {
    const id = nextId++;
    const entry: InflightEntry = {
      id,
      resolve: resolve as (v: unknown) => void,
      reject,
    };

    if (opts.signal) {
      entry.signal = opts.signal;
      const handler = (): void => {
        cleanupEntry(entry);
        const pw = pool.find((p) => p.current === entry);
        if (pw) {
          setTimeout(() => {
            if (pool.includes(pw) && pw.current === entry) retireWorker(pw);
          }, WORKER_CANCEL_GRACE_MS).unref();
        } else {
          // still queued; remove from queue
          const idx = queue.findIndex((q) => q.entry === entry);
          if (idx >= 0) queue.splice(idx, 1);
        }
        const reason: unknown = opts.signal?.reason;
        reject(
          reason instanceof Error
            ? reason
            : new DOMException('Operation aborted', 'AbortError')
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
        const pw = pool.find((p) => p.current === entry);
        if (pw) retireWorker(pw);
        reject(new McpError(ErrorCode.TIMEOUT, 'Worker task timed out'));
      }, opts.timeoutMs);
      tid.unref();
      entry.timeoutId = tid;
    }

    queue.push({
      request: { id, name, payload },
      entry,
    });
    drainQueue();
  });
}

export async function shutdownWorkerPool(): Promise<void> {
  // Reject everything that's still queued.
  while (queue.length > 0) {
    const qt = queue.shift();
    if (!qt) break;
    cleanupEntry(qt.entry);
    qt.entry.reject(
      new McpError(ErrorCode.UNKNOWN, 'Worker pool shutting down')
    );
  }
  // Reject in-flight tasks; terminate workers.
  const toTerminate = [...pool];
  pool = [];
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
  await Promise.all(
    toTerminate.map(async (pw) => {
      if (pw.current) {
        cleanupEntry(pw.current);
        pw.current.reject(
          new McpError(ErrorCode.UNKNOWN, 'Worker pool shutting down')
        );
      }
      try {
        await pw.worker.terminate();
      } catch {
        /* ignore */
      }
    })
  );
}
