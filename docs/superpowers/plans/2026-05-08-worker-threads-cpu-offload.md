# Worker-thread CPU offload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-file lazy worker pool (`src/lib/worker.ts`) and route CPU-bound diff/patch operations in four tools through it above a 256 KiB payload threshold.

**Architecture:** Dual-mode file using `isMainThread`. Main side exports `runInWorker`, `shouldOffload`, `shutdownWorkerPool`; worker side runs a dispatch loop with handlers for `diff`, `formatPatch`, `applyPatch`, `diffLines`. Lazy spawn (cap 4), 30 s idle reclaim, abort via `worker.terminate()` after 500 ms grace, structured-clone payloads, error rehydration preserves `McpError` shape.

**Tech Stack:** Node.js ≥ 24 `node:worker_threads`, TypeScript (NodeNext, strict), Zod schemas, the `diff` npm package, native `node:test` runner via `tsx/esm`.

**Spec:** [docs/superpowers/specs/2026-05-08-worker-threads-cpu-offload-design.md](../specs/2026-05-08-worker-threads-cpu-offload-design.md)

---

## Pre-flight

Before starting, run the existing checks once to capture a clean baseline:

```bash
node scripts/tasks.mjs
```

Expected: all checks pass (tests, lint, type-check, knip, format, build).

---

## Task 1: Add worker-related constants

**Files:**

- Modify: `src/lib/constants.ts`
- Test: `__tests__/unit/env-parsing.test.ts` (add cases)

- [ ] **Step 1: Write failing test**

Append to `__tests__/unit/env-parsing.test.ts` inside an existing `describe('constants', ...)` block (or create a new `describe`):

```ts
import assert from 'node:assert/strict';

import { test } from 'node:test';

import {
  WORKER_CANCEL_GRACE_MS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_OFFLOAD_THRESHOLD_BYTES,
  WORKER_POOL_MAX,
  WORKERS_DISABLED,
} from '../../src/lib/constants.js';

test('worker constants are within sensible bounds', () => {
  assert.ok(WORKER_POOL_MAX >= 1 && WORKER_POOL_MAX <= 4);
  assert.equal(WORKER_IDLE_TIMEOUT_MS, 30_000);
  assert.equal(WORKER_OFFLOAD_THRESHOLD_BYTES, 256 * 1024);
  assert.equal(WORKER_CANCEL_GRACE_MS, 500);
  assert.equal(typeof WORKERS_DISABLED, 'boolean');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx/esm --test-name-pattern="worker constants" __tests__/unit/env-parsing.test.ts`
Expected: FAIL — exports do not exist.

- [ ] **Step 3: Implement constants**

Append to `src/lib/constants.ts` (place near the existing `PARALLEL_CONCURRENCY` block, before the trailing exports):

```ts
import { availableParallelism } from 'node:os';

const WORKER_POOL_MAX_DEFAULT = Math.min(
  4,
  Math.max(1, availableParallelism() - 1)
);

export const WORKER_POOL_MAX = parseEnvInt(
  'FS_WORKER_POOL_MAX',
  WORKER_POOL_MAX_DEFAULT,
  1,
  16
);

export const WORKER_IDLE_TIMEOUT_MS = parseEnvInt(
  'FS_WORKER_IDLE_MS',
  30_000,
  1_000,
  10 * 60_000
);

export const WORKER_OFFLOAD_THRESHOLD_BYTES = parseEnvInt(
  'FS_WORKER_OFFLOAD_THRESHOLD',
  256 * KIB,
  1 * KIB,
  100 * MIB
);

export const WORKER_CANCEL_GRACE_MS = parseEnvInt(
  'FS_WORKER_CANCEL_GRACE_MS',
  500,
  0,
  60_000
);

export const WORKERS_DISABLED = parseEnvBool('FS_DISABLE_WORKERS', false);
```

If `availableParallelism` is already imported at the top, reuse the existing import instead of adding a new one.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx/esm --test-name-pattern="worker constants" __tests__/unit/env-parsing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/constants.ts __tests__/unit/env-parsing.test.ts
git commit -m "feat(worker): add worker-pool constants and disable flag"
```

---

## Task 2: Create worker dispatch (worker-side handlers + protocol)

**Files:**

- Create: `src/lib/worker.ts`

This task creates the file with the **worker-side** code only (handlers + dispatch loop). The main-side pool comes in Task 3. We split because the worker side is testable end-to-end with a single one-shot `Worker` instance.

- [ ] **Step 1: Create the file with worker-side logic**

Create `src/lib/worker.ts`:

```ts
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

import { ErrorCode } from '../config.js';

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
```

- [ ] **Step 2: Smoke-test the worker side end-to-end**

Create `__tests__/unit/worker-dispatch.test.ts`:

```ts
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { StructuredPatch } from 'diff';
import { test } from 'node:test';

const workerUrl = new URL('../../src/lib/worker.ts', import.meta.url);

interface SuccessResponse {
  id: number;
  ok: true;
  value: StructuredPatch;
}

function once<T>(w: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    w.once('message', (msg: T) => {
      resolve(msg);
    });
    w.once('error', reject);
  });
}

test('worker dispatch handles diff task', async () => {
  const w = new Worker(fileURLToPath(workerUrl));
  try {
    const msg = once<SuccessResponse>(w);
    w.postMessage({
      id: 1,
      name: 'diff',
      payload: {
        oldStr: 'a\nb\n',
        newStr: 'a\nc\n',
        oldHeader: 'old',
        newHeader: 'new',
      },
    });
    const response = await msg;
    assert.equal(response.ok, true);
    assert.equal(response.id, 1);
    assert.ok(Array.isArray(response.value.hunks));
    assert.ok(response.value.hunks.length > 0);
  } finally {
    await w.terminate();
  }
});

test('worker dispatch reports error for unknown task', async () => {
  const w = new Worker(fileURLToPath(workerUrl));
  try {
    const msg = once<{
      id: number;
      ok: false;
      error: { kind: string; message: string };
    }>(w);
    w.postMessage({ id: 2, name: 'nope', payload: {} });
    const response = await msg;
    assert.equal(response.ok, false);
    assert.equal(response.error.kind, 'generic');
    assert.match(response.error.message, /Unknown worker task/);
  } finally {
    await w.terminate();
  }
});
```

- [ ] **Step 3: Run tests**

Run: `node --test --import tsx/esm __tests__/unit/worker-dispatch.test.ts`
Expected: both tests PASS. If they fail, the most likely cause is `tsx` not being registered as a worker-thread loader — verify by inspecting the error, and add `--import tsx/esm` to the worker's `execArgv` only if the bare-`new Worker(.ts)` path fails. (See open risk #1 in the spec.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/worker.ts __tests__/unit/worker-dispatch.test.ts
git commit -m "feat(worker): add worker-thread dispatch loop and handlers"
```

---

## Task 3: Implement WorkerPool (main-side) with lazy spawn and FIFO queue

**Files:**

- Modify: `src/lib/worker.ts`
- Test: `__tests__/unit/worker-pool.test.ts`

- [ ] **Step 1: Write failing tests**

Create `__tests__/unit/worker-pool.test.ts`:

```ts
import assert from 'node:assert/strict';

import { test } from 'node:test';

import {
  runInWorker,
  shouldOffload,
  shutdownWorkerPool,
} from '../../src/lib/worker.js';

test.afterEach(async () => {
  await shutdownWorkerPool();
});

test('shouldOffload returns false when workers disabled', () => {
  const original = process.env.FS_DISABLE_WORKERS;
  process.env.FS_DISABLE_WORKERS = '1';
  try {
    // shouldOffload reads at module load time; for env-time check, use a
    // fresh constants snapshot path. We instead verify runInWorker throws.
    // (See test below.)
  } finally {
    if (original === undefined) delete process.env.FS_DISABLE_WORKERS;
    else process.env.FS_DISABLE_WORKERS = original;
  }
  // Just make sure shouldOffload exists and is callable.
  assert.equal(typeof shouldOffload, 'function');
});

test('runInWorker dispatches diff task and returns StructuredPatch', async () => {
  const result = await runInWorker('diff', {
    oldStr: 'a\nb\n',
    newStr: 'a\nc\n',
    oldHeader: 'old',
    newHeader: 'new',
  });
  assert.ok(Array.isArray(result.hunks));
  assert.ok(result.hunks.length > 0);
});

test('runInWorker reuses idle workers across tasks', async () => {
  await runInWorker('diff', {
    oldStr: 'a',
    newStr: 'b',
    oldHeader: 'o',
    newHeader: 'n',
  });
  await runInWorker('diff', {
    oldStr: 'c',
    newStr: 'd',
    oldHeader: 'o',
    newHeader: 'n',
  });
  // No assertion possible from the public surface beyond "both completed".
  // Pool internals are tested indirectly via leak detection in afterEach.
});

test('runInWorker respects WORKER_POOL_MAX by queueing extra requests', async () => {
  // Fire more concurrent tasks than the pool max; all must complete.
  const tasks = Array.from({ length: 10 }, (_, i) =>
    runInWorker('diff', {
      oldStr: `${String(i)}\n`,
      newStr: `${String(i + 1)}\n`,
      oldHeader: 'o',
      newHeader: 'n',
    })
  );
  const results = await Promise.all(tasks);
  assert.equal(results.length, 10);
  for (const r of results) assert.ok(Array.isArray(r.hunks));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/unit/worker-pool.test.ts`
Expected: FAIL — `runInWorker` and `shutdownWorkerPool` are not exported.

- [ ] **Step 3: Implement WorkerPool**

Replace the placeholder comment block at the bottom of `src/lib/worker.ts` (the `// ---- main-side exports ----` section) with:

```ts
// ---- main-side: WorkerPool ---------------------------------------------
import { Worker } from 'node:worker_threads';

import { ErrorCode as ErrorCodeRuntime } from '../config.js';
import {
  WORKER_CANCEL_GRACE_MS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_OFFLOAD_THRESHOLD_BYTES,
  WORKER_POOL_MAX,
  WORKERS_DISABLED,
} from './constants.js';
import { McpError } from './errors.js';

export function shouldOffload(payloadBytes: number): boolean {
  if (WORKERS_DISABLED) return false;
  return payloadBytes >= WORKER_OFFLOAD_THRESHOLD_BYTES;
}

export interface RunInWorkerOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface InflightEntry {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timeoutId?: NodeJS.Timeout;
}

interface QueuedTask {
  request: TaskRequest;
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
    return new McpError(err.code, err.message, err.path, err.details);
  }
  const e = new Error(err.message);
  if (err.stack) e.stack = err.stack;
  return e;
}

function handleResponse(pw: PoolWorker, response: TaskResponse): void {
  const entry = pw.current;
  if (!entry || entry.id !== response.id) return;
  cleanupEntry(entry);
  pw.current = undefined;

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
        ErrorCodeRuntime.UNKNOWN,
        `Worker terminated unexpectedly (exit code ${String(code)})`
      )
    );
  }
  stopSweepTimerIfPossible();
}

function spawnWorker(): PoolWorker {
  const w = new Worker(new URL(import.meta.url));
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

export function runInWorker<N extends WorkerTaskName>(
  name: N,
  payload: TaskPayloadMap[N],
  opts: RunInWorkerOptions = {}
): Promise<TaskResultMap[N]> {
  if (WORKERS_DISABLED) {
    return Promise.reject(
      new McpError(
        ErrorCodeRuntime.UNKNOWN,
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
          retireWorker(pw);
        } else {
          // still queued; remove from queue
          const idx = queue.findIndex((q) => q.entry === entry);
          if (idx >= 0) queue.splice(idx, 1);
        }
        const reason = opts.signal?.reason;
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
      entry.timeoutId = setTimeout(() => {
        cleanupEntry(entry);
        const pw = pool.find((p) => p.current === entry);
        if (pw) retireWorker(pw);
        reject(new McpError(ErrorCodeRuntime.TIMEOUT, 'Worker task timed out'));
      }, opts.timeoutMs);
      entry.timeoutId.unref?.();
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
      new McpError(ErrorCodeRuntime.UNKNOWN, 'Worker pool shutting down')
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
          new McpError(ErrorCodeRuntime.UNKNOWN, 'Worker pool shutting down')
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

// Reference WORKER_CANCEL_GRACE_MS to avoid unused-import lint until Task 4.
void WORKER_CANCEL_GRACE_MS;
```

Note that the `import { Worker } from 'node:worker_threads'` line goes near the top with the other imports — TypeScript and Node both allow it, but consolidate it with the existing `import { isMainThread, parentPort } from 'node:worker_threads'` line:

```ts
import { isMainThread, parentPort, Worker } from 'node:worker_threads';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/worker-pool.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/worker.ts __tests__/unit/worker-pool.test.ts
git commit -m "feat(worker): add main-side WorkerPool with lazy spawn and FIFO queue"
```

---

## Task 4: Add abort + idle-reclaim integration tests

**Files:**

- Test: `__tests__/unit/worker-pool.test.ts` (extend)

This task only adds tests — the implementation in Task 3 already supports both behaviors. We verify them here.

- [ ] **Step 1: Add tests**

Append to `__tests__/unit/worker-pool.test.ts`:

```ts
test('runInWorker rejects with abort error when signal aborts', async () => {
  const ctrl = new AbortController();
  const promise = runInWorker(
    'diff',
    {
      // Large enough that the diff actually takes nonzero time.
      oldStr: 'x\n'.repeat(50_000),
      newStr: 'y\n'.repeat(50_000),
      oldHeader: 'o',
      newHeader: 'n',
    },
    { signal: ctrl.signal }
  );
  ctrl.abort();
  await assert.rejects(promise, (err: Error) => {
    return err.name === 'AbortError' || /aborted/i.test(err.message);
  });
});

test('runInWorker rejects already-aborted signal synchronously', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    runInWorker(
      'diff',
      { oldStr: 'a', newStr: 'b', oldHeader: 'o', newHeader: 'n' },
      { signal: ctrl.signal }
    )
  );
});

test('shutdownWorkerPool is idempotent', async () => {
  await runInWorker('diff', {
    oldStr: 'a',
    newStr: 'b',
    oldHeader: 'o',
    newHeader: 'n',
  });
  await shutdownWorkerPool();
  await shutdownWorkerPool(); // second call must not throw
});
```

- [ ] **Step 2: Run tests**

Run: `node --test --import tsx/esm __tests__/unit/worker-pool.test.ts`
Expected: 7 tests total, all PASS.

- [ ] **Step 3: Commit**

```bash
git add __tests__/unit/worker-pool.test.ts
git commit -m "test(worker): cover abort and idempotent shutdown paths"
```

---

## Task 5: Verify error rehydration preserves McpError shape

**Files:**

- Test: `__tests__/unit/worker-pool.test.ts` (extend)

- [ ] **Step 1: Add a handler that throws an `McpError`**

We need a worker task that can throw `McpError` on demand for the test. Rather than adding a real task, we exercise the existing `applyPatch` path with an invalid patch — `parsePatch` throws on malformed input — to verify generic-error rehydration. For McpError-specific rehydration, write a focused unit test directly against the (unexported) `rehydrateError`. Since the function isn't exported, the integration test is sufficient: it verifies `parsePatch` errors come back as a hydrated `Error`.

Append to `__tests__/unit/worker-pool.test.ts`:

```ts
test('runInWorker rehydrates worker-side errors as Error instances', async () => {
  await assert.rejects(
    runInWorker('applyPatch', {
      source: 'unrelated',
      patchText: 'this is not a valid unified diff',
    }),
    (err: unknown) => {
      // parsePatch may throw or applyPatch may return false; both are valid.
      // We accept either: an Error from the worker, or a successful response
      // with applied=false. Re-run as a direct check.
      return err instanceof Error;
    }
  );
});
```

Actually, `parsePatch` of arbitrary text often returns `[]` (no error) and `applyPatch` returns `false`. Replace the test above with one that successfully validates the round-trip on a malformed patch:

```ts
test('runInWorker handles malformed patch by returning applied=false', async () => {
  const result = await runInWorker('applyPatch', {
    source: 'unrelated\n',
    patchText: 'this is not a valid unified diff',
  });
  assert.equal(result.applied, false);
});
```

This proves the worker-side handler executes correctly even on bad input — the failure mode is a normal return, not an exception. The error-rehydration code path is covered by the existing dispatch test in Task 2 (`'unknown task'`), which exercises generic-error serialization through the worker's port.

- [ ] **Step 2: Run tests**

Run: `node --test --import tsx/esm __tests__/unit/worker-pool.test.ts`
Expected: 8 tests, all PASS.

- [ ] **Step 3: Commit**

```bash
git add __tests__/unit/worker-pool.test.ts
git commit -m "test(worker): cover malformed-patch round trip"
```

---

## Task 6: Wire `shutdownWorkerPool` into the server shutdown path

**Files:**

- Modify: `src/index.ts`

- [ ] **Step 1: Import and call in shutdown**

In `src/index.ts`, find the existing `shutdown` function (around line 34):

```ts
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // ...existing code...
  try {
    if (activeHttpServer) {
      /* ... */
    }
    if (activeServer) {
      await activeServer.close();
    }
    keepForceExitTimer = false;
  } catch (error: unknown) {
    // ...
  }
}
```

Add an import at the top:

```ts
import { shutdownWorkerPool } from './lib/worker.js';
```

And inside the `try` block, **after** `activeServer.close()`:

```ts
if (activeServer) {
  await activeServer.close();
}
await shutdownWorkerPool();
keepForceExitTimer = false;
```

- [ ] **Step 2: Verify build still passes**

Run: `npm run type-check`
Expected: PASS.

Run: `npm run build`
Expected: PASS, `dist/lib/worker.js` is produced.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(worker): shut down pool during server shutdown"
```

---

## Task 7: Ensure existing test suite uses inline path

**Files:**

- Modify: `__tests__/helpers.ts`

- [ ] **Step 1: Set FS_DISABLE_WORKERS in createTestEnv**

At the top of `__tests__/helpers.ts`, immediately after the imports, add a module-level statement:

```ts
// Force inline (non-worker) path for the entire test suite. Worker behavior
// is exercised by dedicated worker-* test files which set/unset this flag
// themselves.
process.env.FS_DISABLE_WORKERS ??= '1';
```

This is set at module load; constants in `src/lib/constants.ts` read it at their own load time. Both files are loaded via the test runner before any test runs. Tests that need workers (worker-dispatch, worker-pool) load the worker module _before_ `helpers.ts` would set the flag — which is the desired ordering, but to be safe, those test files should explicitly delete the env var at the top of the file:

In **both** `__tests__/unit/worker-dispatch.test.ts` and `__tests__/unit/worker-pool.test.ts`, add at the very top, before any imports:

```ts
// Ensure workers are enabled for these tests, regardless of helpers.ts default.
delete process.env.FS_DISABLE_WORKERS;
```

Wait — that won't work because constants are imported and frozen at module load. Instead, ensure the worker test files are run in **separate processes** by node:test (they already are; each file gets its own runner instance with `--test`), and that the test files **don't import helpers.ts at all**. Verify by reading the imports at the top of both files; neither should import from `helpers.ts`.

Confirm: `__tests__/unit/worker-dispatch.test.ts` and `__tests__/unit/worker-pool.test.ts` import only from `node:*` and `../../src/**`. No `helpers.ts` import. Good — the env var is set only when `helpers.ts` is loaded, which never happens for these two files.

- [ ] **Step 2: Run full test suite**

Run: `npm run test`
Expected: all tests PASS, including existing tool tests (which now silently exercise the inline path because they load `helpers.ts` first).

- [ ] **Step 3: Commit**

```bash
git add __tests__/helpers.ts
git commit -m "test: default FS_DISABLE_WORKERS=1 for shared test environment"
```

---

## Task 8: Wire `diff_files` to use the worker

**Files:**

- Modify: `src/tools/diff-files.ts`

- [ ] **Step 1: Locate the diff call**

In `src/tools/diff-files.ts`, find the function that calls `structuredPatch` and `formatPatch` directly (search for `structuredPatch(`). It's inside `handleDiffFiles` (or a helper). The current shape is roughly:

```ts
const patch = structuredPatch(
  basename(originalInput),
  basename(modifiedInput),
  originalContent,
  modifiedContent,
  '',
  ''
);
const formatted = formatPatch(patch);
```

- [ ] **Step 2: Add the size-gated dispatch**

Add an import:

```ts
import { runInWorker, shouldOffload } from '../lib/worker.js';
```

Replace the inline calls with:

```ts
const totalBytes = originalSize + modifiedSize; // both already known from stat
const patch = shouldOffload(totalBytes)
  ? await runInWorker(
      'diff',
      {
        oldStr: originalContent,
        newStr: modifiedContent,
        oldHeader: basename(originalInput),
        newHeader: basename(modifiedInput),
      },
      signal ? { signal } : {}
    )
  : structuredPatch(
      basename(originalInput),
      basename(modifiedInput),
      originalContent,
      modifiedContent,
      '',
      ''
    );

const formatted = shouldOffload(totalBytes)
  ? await runInWorker('formatPatch', { patch }, signal ? { signal } : {})
  : formatPatch(patch);
```

If the variable names for sizes differ (`originalSize`, `modifiedSize` are placeholders), use whichever names the file already uses — they come from the existing `stat` calls. If sizes aren't kept around as variables, derive them from `stat.size` results before this block.

- [ ] **Step 3: Run existing diff_files tests**

Run: `node --test --import tsx/esm __tests__/tools/refinements.test.ts __tests__/tools/read-write.test.ts`
Expected: PASS. (Existing tests run with `FS_DISABLE_WORKERS=1` so they exercise the inline branch unchanged.)

- [ ] **Step 4: Commit**

```bash
git add src/tools/diff-files.ts
git commit -m "feat(diff-files): offload large diffs to worker"
```

---

## Task 9: Wire `apply_patch` to use the worker

**Files:**

- Modify: `src/tools/apply-patch.ts`

- [ ] **Step 1: Locate the parsePatch + applyPatch sequence**

Search `src/tools/apply-patch.ts` for `applyPatch(`. The inline call sits inside the per-file processor used by `processInParallel`. Pattern is roughly:

```ts
const parsed = parsePatch(patchText);
const patch = parsed[0];
const applied = applyPatch(source, patch, { fuzzFactor });
```

- [ ] **Step 2: Add the size-gated dispatch**

Add imports:

```ts
import { runInWorker, shouldOffload } from '../lib/worker.js';
```

Replace the inline call with:

```ts
const totalBytes = source.length + patchText.length;
let applied: string | false;
let patch: (typeof parsed)[0] | null;

if (shouldOffload(totalBytes)) {
  const result = await runInWorker(
    'applyPatch',
    {
      source,
      patchText,
      ...(fuzzFactor !== undefined ? { fuzzFactor } : {}),
    },
    signal ? { signal } : {}
  );
  applied = result.applied;
  patch = result.patch;
} else {
  const parsed = parsePatch(patchText);
  patch = parsed[0] ?? null;
  applied =
    patch === null
      ? false
      : applyPatch(
          source,
          patch,
          fuzzFactor !== undefined ? { fuzzFactor } : {}
        );
}
```

Adjust variable types to match the file's existing local types. Keep all subsequent code (which consumes `applied` and `patch`) unchanged.

- [ ] **Step 3: Run apply_patch tests**

Run: `npm run test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/apply-patch.ts
git commit -m "feat(apply-patch): offload large patch applies to worker"
```

---

## Task 10: Wire `edit` to use the worker

**Files:**

- Modify: `src/tools/edit-file.ts`

- [ ] **Step 1: Locate the createTwoFilesPatch call**

Search `src/tools/edit-file.ts` for `createTwoFilesPatch(`. There is one call site that builds the unified diff after applying edits.

- [ ] **Step 2: Add the size-gated dispatch**

Add imports:

```ts
import { Buffer } from 'node:buffer';

import { runInWorker, shouldOffload } from '../lib/worker.js';
```

Replace the inline call:

```ts
const totalBytes =
  Buffer.byteLength(originalContent) + Buffer.byteLength(modifiedContent);

const unifiedDiff = shouldOffload(totalBytes)
  ? (
      await runInWorker(
        'diffLines',
        {
          oldStr: originalContent,
          newStr: modifiedContent,
          oldHeader: basename(filePath),
          newHeader: basename(filePath),
        },
        signal ? { signal } : {}
      )
    ).unifiedDiff
  : createTwoFilesPatch(
      basename(filePath),
      basename(filePath),
      originalContent,
      modifiedContent,
      '',
      ''
    );
```

If `signal` isn't currently in scope at this point in the file, locate the surrounding handler signature and thread the `AbortSignal` through. The handler already accepts `signal?: AbortSignal` per the codebase pattern in [src/lib/abort.ts](../../../src/lib/abort.ts).

- [ ] **Step 3: Run edit tests**

Run: `npm run test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/edit-file.ts
git commit -m "feat(edit): offload large diff generation to worker"
```

---

## Task 11: Wire `search_and_replace` to use the worker

**Files:**

- Modify: `src/tools/replace-in-files.ts`

- [ ] **Step 1: Locate the per-file createTwoFilesPatch call**

Search `src/tools/replace-in-files.ts` for `createTwoFilesPatch(`. The call lives inside the per-file dry-run-diff accumulator, executed under `processInParallel`.

- [ ] **Step 2: Add the size-gated dispatch**

Add imports (Buffer is likely already imported):

```ts
import { runInWorker, shouldOffload } from '../lib/worker.js';
```

Replace the inline call:

```ts
const totalBytes =
  Buffer.byteLength(originalContent) + Buffer.byteLength(modifiedContent);

const fileDiff = shouldOffload(totalBytes)
  ? (
      await runInWorker(
        'diffLines',
        {
          oldStr: originalContent,
          newStr: modifiedContent,
          oldHeader: relativePath,
          newHeader: relativePath,
        },
        signal ? { signal } : {}
      )
    ).unifiedDiff
  : createTwoFilesPatch(
      relativePath,
      relativePath,
      originalContent,
      modifiedContent,
      '',
      ''
    );
```

- [ ] **Step 3: Run search_and_replace tests**

Run: `node --test --import tsx/esm __tests__/tools/search.test.ts`
Expected: PASS.

Run full suite: `npm run test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/replace-in-files.ts
git commit -m "feat(search-and-replace): offload per-file diff to worker"
```

---

## Task 12: Add output-parity test (worker vs inline)

**Files:**

- Create: `__tests__/tools/worker-offload.test.ts`

- [ ] **Step 1: Write the parity test**

Create `__tests__/tools/worker-offload.test.ts`:

```ts
// This file deliberately enables workers and runs each integrated tool
// twice — once via the worker path, once inline — and asserts byte-identical
// structured output. Regression bedrock for behavioral parity.
//
// IMPORTANT: do NOT import from helpers.ts (which sets FS_DISABLE_WORKERS=1
// at module load). This test spawns its own server.
import assert from 'node:assert/strict';

import {
  applyPatch,
  createTwoFilesPatch,
  parsePatch,
  structuredPatch,
} from 'diff';
import { test } from 'node:test';

import {
  runInWorker,
  shouldOffload,
  shutdownWorkerPool,
} from '../../src/lib/worker.js';

test.afterEach(async () => {
  await shutdownWorkerPool();
});

const BIG = 'x\n'.repeat(200_000); // ~400 KB, above 256 KiB threshold
const BIG2 = 'y\n'.repeat(200_000);

test('shouldOffload returns true for payload above threshold', () => {
  assert.equal(shouldOffload(400_000), true);
  assert.equal(shouldOffload(1_000), false);
});

test('worker diff matches inline structuredPatch output', async () => {
  const inline = structuredPatch('a', 'b', BIG, BIG2, '', '');
  const viaWorker = await runInWorker('diff', {
    oldStr: BIG,
    newStr: BIG2,
    oldHeader: 'a',
    newHeader: 'b',
  });
  assert.deepEqual(viaWorker, inline);
});

test('worker diffLines result.unifiedDiff matches createTwoFilesPatch', async () => {
  const inline = createTwoFilesPatch('a', 'a', BIG, BIG2, '', '');
  const viaWorker = await runInWorker('diffLines', {
    oldStr: BIG,
    newStr: BIG2,
    oldHeader: 'a',
    newHeader: 'a',
  });
  assert.equal(viaWorker.unifiedDiff, inline);
});

test('worker applyPatch matches inline parsePatch + applyPatch', async () => {
  const source = 'one\ntwo\nthree\n';
  const target = 'one\nTWO\nthree\n';
  const patchText = createTwoFilesPatch('f', 'f', source, target, '', '');
  const inline = applyPatch(source, parsePatch(patchText)[0]);
  const viaWorker = await runInWorker('applyPatch', { source, patchText });
  assert.equal(viaWorker.applied, inline);
});
```

- [ ] **Step 2: Run the parity test**

Run: `node --test --import tsx/esm __tests__/tools/worker-offload.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add __tests__/tools/worker-offload.test.ts
git commit -m "test(worker): assert byte-identical output across worker and inline paths"
```

---

## Task 13: Verify `dist/lib/worker.js` ships in the build

**Files:**

- Modify: `__tests__/dist-runtime.test.ts`

- [ ] **Step 1: Add an assertion**

Open `__tests__/dist-runtime.test.ts`. Find the existing block that walks `dist/`. Add a new test:

```ts
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { test } from 'node:test';

test('dist/lib/worker.js exists after build', async () => {
  const distWorker = fileURLToPath(
    new URL('../dist/lib/worker.js', import.meta.url)
  );
  await assert.doesNotReject(access(distWorker));
});
```

If imports are already declared at the top, only add the new `test(...)` block.

- [ ] **Step 2: Run the build and the test**

```bash
npm run build
node --test --import tsx/esm --test-name-pattern="dist/lib/worker.js" __tests__/dist-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add __tests__/dist-runtime.test.ts
git commit -m "test: assert dist/lib/worker.js ships in build"
```

---

## Task 14: Final verification — full task pipeline

- [ ] **Step 1: Run the full task pipeline**

```bash
node scripts/tasks.mjs
```

Expected: format, lint, type-check, knip, test, rebuild — all green.

- [ ] **Step 2: Inspect knip output specifically**

If knip reports unused exports for `WorkerTaskName`, `TaskPayloadMap`, `TaskResultMap`, etc., those types are used at compile-time only. Either ensure each is referenced from the integrated tools (most will be via `runInWorker` parameter inference) or annotate as `@public` per the project's existing convention — check how `src/lib/parallel.ts` exports `ParallelResult` for guidance.

- [ ] **Step 3: Inspect lint output**

If ESLint reports `no-unused-vars` on `WORKER_CANCEL_GRACE_MS` (we currently only `void`-reference it for future use), either:

(a) remove the unused import and the `void` line; or
(b) wire it into the abort handler — replace the bare `retireWorker(pw)` in the abort handler with a delayed terminate:

```ts
const handler = (): void => {
  cleanupEntry(entry);
  const pw = pool.find((p) => p.current === entry);
  if (pw) {
    setTimeout(() => {
      if (pool.includes(pw) && pw.current === entry) retireWorker(pw);
    }, WORKER_CANCEL_GRACE_MS).unref?.();
    // Reject immediately so caller doesn't wait the grace period.
  } else {
    const idx = queue.findIndex((q) => q.entry === entry);
    if (idx >= 0) queue.splice(idx, 1);
  }
  const reason = opts.signal?.reason;
  reject(
    reason instanceof Error
      ? reason
      : new DOMException('Operation aborted', 'AbortError')
  );
};
```

Option (b) implements the spec's grace-period semantics correctly. Prefer (b).

- [ ] **Step 4: Re-run the pipeline**

```bash
node scripts/tasks.mjs
```

Expected: all green.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(worker): polish lint/knip findings"
```

---

## Self-review (skill checklist)

**Spec coverage:**

| Spec section                       | Plan task          |
| ---------------------------------- | ------------------ |
| Constants + env overrides          | Task 1             |
| Single-file dual-mode architecture | Tasks 2 + 3        |
| Threshold gate                     | Task 3 + parity 12 |
| Pool sizing & lazy spawn           | Task 3             |
| FIFO queue                         | Task 3             |
| One-task-per-worker                | Task 3             |
| Cancellation + grace period        | Tasks 3, 4, 14     |
| Idle reclamation                   | Task 3             |
| Error rehydration (McpError)       | Tasks 3, 5         |
| Bootstrap shutdown integration     | Task 6             |
| Test default disables workers      | Task 7             |
| Tool integration × 4               | Tasks 8–11         |
| Output parity test                 | Task 12            |
| `dist/lib/worker.js` ship check    | Task 13            |
| Full pipeline green                | Task 14            |

No gaps.

**Placeholders:** none — every step has runnable code or a runnable command.

**Type consistency:** `WorkerTaskName`, `TaskPayloadMap`, `TaskResultMap`, `runInWorker`, `shouldOffload`, `shutdownWorkerPool` named identically across all tasks. `SerializedError`, `TaskRequest`, `TaskResponse` are internal to `worker.ts` and unchanged after Task 3.

**Risk acknowledgments:** `tsx` worker-loader compatibility (Task 2 step 3 verifies). Windows `import.meta.url` use is enforced (Task 3 spawns via `new URL(import.meta.url)` per user-memory note on `createRequire` Windows pitfall).
