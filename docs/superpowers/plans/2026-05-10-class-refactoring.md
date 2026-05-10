# Class Architecture Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor key module-level states and closure factories into strict ES6 classes to improve testability, prevent memory leaks, and streamline instantiation logic.

**Architecture:** We will replace closures and global variables in the worker pool, resource store, path completer, server context, and observability subsystems with `export class` definitions. This brings structural consistency across the repository.

**Tech Stack:** TypeScript, Node.js

---

## Task 1: `WorkerPool` Refactor (`src/core/concurrency.ts`)

**Files:**

- Modify: `src/core/concurrency.ts`
- Test: `__tests__/unit/worker-pool.test.ts`

- [ ] **Step 1: Run tests to verify baseline**

```bash
node scripts/tasks.mjs --quick

```

Expected: PASS

- [ ] **Step 2: Wrap module state into `export class WorkerPool`**

```typescript
// Add to src/core/concurrency.ts (replace the `state` object and free functions)
export class WorkerPool {
  private workers: PoolWorker[] = [];
  private queue: QueuedTask[] = [];
  private sweepTimer?: NodeJS.Timeout;

  public async run<N extends WorkerTaskName>(
    taskName: N,
    payload: Extract<TaskRequest, { task: N }>['payload'],
  ): Promise<TaskResultMap[N]> {
    return new Promise((resolve, reject) => {
      const entry: InflightEntry = { id: randomUUID(), resolve, reject };
      this.queue.push({ request: { task: taskName, id: entry.id, payload }, entry });
      this.drainQueue();
    });
  }

  public shutdown(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const promises = this.workers.map((pw) => pw.worker.terminate());
    this.workers = [];
    this.queue = [];
    return Promise.all(promises).then(() => undefined);
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

  private pickIdleWorker(): PoolWorker | undefined {
    return this.workers.find((p) => p.state === 'idle');
  }

  private dispatch(pw: PoolWorker, qt: QueuedTask): void {
    pw.state = 'busy';
    pw.current = qt.entry;
    pw.worker.postMessage(qt.request);
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
      if (pw.current) {
        pw.current.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    w.on('exit', () => {
      this.removeWorker(pw);
      if (pw.current) {
        pw.current.reject(new McpError(ErrorCode.UNKNOWN, `Worker terminated unexpectedly`));
      }
    });
    this.workers.push(pw);
    this.startSweepTimerIfNeeded();
    return pw;
  }

  private handleResponse(pw: PoolWorker, response: TaskResponse): void {
    const entry = pw.current;
    if (entry?.id !== response.id) return;
    delete pw.current;

    if (response.ok) {
      entry.resolve(response.value);
    } else {
      const e = new Error(response.error.message);
      entry.reject(e);
    }

    pw.state = 'idle';
    pw.lastIdleAt = Date.now();
    this.drainQueue();
  }

  private removeWorker(pw: PoolWorker): void {
    const idx = this.workers.indexOf(pw);
    if (idx !== -1) this.workers.splice(idx, 1);
  }

  private startSweepTimerIfNeeded(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (let i = this.workers.length - 1; i >= 0; i--) {
        const pw = this.workers[i];
        if (pw?.state === 'idle' && now - pw.lastIdleAt >= WORKER_IDLE_TIMEOUT_MS) {
          pw.state = 'terminating';
          this.removeWorker(pw);
          void pw.worker.terminate();
        }
      }
      if (this.workers.length === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
      }
    }, 10_000);
    this.sweepTimer.unref();
  }
}

// Global instance for convenience (preserving old API)
const globalWorkerPool = new WorkerPool();

export function runInWorker<N extends WorkerTaskName>(
  taskName: N,
  payload: Extract<TaskRequest, { task: N }>['payload'],
): Promise<TaskResultMap[N]> {
  return globalWorkerPool.run(taskName, payload);
}

export async function shutdownWorkerPool(): Promise<void> {
  await globalWorkerPool.shutdown();
}
```

- [ ] **Step 3: Clean up old code**
      Remove the old `state` object, `sweepIdleWorkers`, `spawnWorker`, `drainQueue` free functions from `src/core/concurrency.ts`.

- [ ] **Step 4: Run tests to verify**

```bash
node scripts/tasks.mjs --quick

```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/concurrency.ts
git commit -m "refactor: wrap WorkerPool into a class"

```

---

## Task 2: `InMemoryResourceStore` Refactor (`src/core/store.ts`)

**Files:**

- Modify: `src/core/store.ts`, `src/server.ts`, `__tests__/unit/resource-store.test.ts`, `__tests__/unit/resource-store-blob.test.ts`

- [ ] **Step 1: Refactor `store.ts`**

```typescript
// Replace createInMemoryResourceStore with this class in src/core/store.ts
export class InMemoryResourceStore implements ResourceStore {
  private readonly options: ResourceStoreOptions;
  private readonly byUri = new Map<string, StoredEntry>();
  private readonly byHashIndex = new Map<string, string>();
  private totalBytes = 0;

  constructor(options: Partial<ResourceStoreOptions> = {}) {
    this.options = { ...DEFAULT_RESOURCE_STORE_OPTIONS, ...options };
  }

  public putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry {
    return this._put(
      'text',
      { name: params.name, mimeType: params.mimeType ?? 'text/plain', data: params.text },
      (base) => ({ ...base, kind: 'text', text: params.text }),
    ) as TextResourceEntry & { kind: 'text' };
  }

  public getText(uri: string): TextResourceEntry {
    return this._getExisting(uri, 'text') as TextResourceEntry & { kind: 'text' };
  }

  public putBlob(params: { name: string; mimeType: string; data: Buffer }): BlobResourceEntry {
    return this._put(
      'blob',
      { name: params.name, mimeType: params.mimeType, data: params.data },
      (base) => ({ ...base, kind: 'blob', data: params.data }),
    ) as BlobResourceEntry & { kind: 'blob' };
  }

  public getBlob(uri: string): BlobResourceEntry {
    return this._getExisting(uri, 'blob') as BlobResourceEntry & { kind: 'blob' };
  }

  public getEntry(uri: string): StoredEntry {
    return this._getExisting(uri);
  }

  public clear(): void {
    const bytesBeforeClear = this.totalBytes;
    this.byUri.clear();
    this.byHashIndex.clear();
    this.totalBytes = 0;
    publishResourceStoreDiagnostics({ phase: 'cache_clear', bytes: bytesBeforeClear });
  }

  public keys(): string[] {
    this.pruneExpiredEntries();
    return Array.from(this.byUri.keys());
  }

  // Define remaining private methods _put, _getExisting, removeEntry, pruneExpiredEntries, etc. inside the class using `this.byUri`, `this.options`.
}
```

- [ ] **Step 2: Update usages in tests**

Modify `__tests__/unit/resource-store.test.ts` and `__tests__/unit/resource-store-blob.test.ts`:

```typescript
// Replace:
const store = createInMemoryResourceStore({ entryTtlMs: 5 });
// With:
const store = new InMemoryResourceStore({ entryTtlMs: 5 });

```

- [ ] **Step 3: Update `src/server.ts`**

Modify `src/server.ts`:

```typescript
// Replace:
const resourceStore = createInMemoryResourceStore();
// With:
const resourceStore = new InMemoryResourceStore();

```

- [ ] **Step 4: Run tests**

```bash
node scripts/tasks.mjs --quick

```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/server.ts __tests__/unit/resource-store*
git commit -m "refactor: convert InMemoryResourceStore to class"

```

---

## Task 3: `DiagnosticsManager` Refactor (`src/core/observability.ts`)

**Files:**

- Modify: `src/core/observability.ts`

- [ ] **Step 1: Create `DiagnosticsManager` class**

```typescript
// Add to src/core/observability.ts
export class DiagnosticsManager {
  private observer?: PerformanceObserver;
  private traceCounter = 0;

  public ensureObserver(): void {
    if (this.observer) return;
    this.observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (const entry of entries) {
        CHANNELS.perf.publish({
          phase: 'measure',
          name: entry.name,
          durationMs: entry.duration,
          detail: (entry as { detail?: unknown }).detail,
        } satisfies PerfDiagnosticsEvent);
      }
      for (const entry of entries) {
        performance.clearMeasures(entry.name);
      }
    });
    this.observer.observe({ entryTypes: ['measure'] });
  }

  public getNextTraceId(): number {
    return ++this.traceCounter;
  }
}

// Instantiate locally
export const diagnosticsManager = new DiagnosticsManager();
```

- [ ] **Step 2: Replace global variables**
      Update `startPerfMeasure` to use `diagnosticsManager`:

```typescript
export function startPerfMeasure(
  name: string,
  detail?: Record<string, unknown>,
): ((ok?: boolean) => void) | undefined {
  if (!readConfig().enabled || !CHANNELS.perf.hasSubscribers) return undefined;

  diagnosticsManager.ensureObserver();
  const id = diagnosticsManager.getNextTraceId();
  // rest of startPerfMeasure logic
}
```

- [ ] **Step 3: Run tests**

```bash
node scripts/tasks.mjs --quick

```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/observability.ts
git commit -m "refactor: encapsulate observability singletons into DiagnosticsManager"

```

---

## Task 4: `PathCompleter` Refactor (`src/core/path.ts`)

**Files:**

- Modify: `src/core/path.ts`

- Modify: `src/tools.ts` (if needed for instantiation)

- [ ] **Step 1: Build `PathCompleter` class in `src/core/path.ts`**

```typescript
export class PathCompleter {
  private cache = new Map<string, CacheEntry>();

  constructor(private pathGuard: PathGuard) {}

  public async suggest(
    value: string,
    argumentName: string,
    contextArguments?: Record<string, string>,
  ): Promise<string[]> {
    const cacheKey = buildCacheKey(argumentName, value, contextArguments);
    const now = Date.now();
    const cacheEntry = this.cache.get(cacheKey);

    if (cacheEntry && now - cacheEntry.ms < COMPLETION_RATE_LIMIT_MS) {
      return cacheEntry.result;
    }

    const results = await this.completePathInternal(value, argumentName, contextArguments);
    this.setCacheValue(cacheKey, { ms: now, result: results });
    return results;
  }

  private async completePathInternal(
    value: string,
    argumentName: string,
    contextArguments?: Record<string, string>,
  ): Promise<string[]> {
    // move logic from `completePath` here
    const allowed = this.pathGuard.getAllowedDirectories();
    // ...
    return [];
  }

  private setCacheValue(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_COMPLETION_CACHE_KEYS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
```

- [ ] **Step 2: Clean up old globals**
      Remove `completionState`, `getCompletionState`, `setCacheValue`, `completePath`, and `completePathCached` free functions.

- [ ] **Step 3: Run tests**

```bash
node scripts/tasks.mjs --quick

```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/path.ts
git commit -m "refactor: encapsulate completion logic inside PathCompleter class"

```

---

## Task 5: `FilesystemServerContext` Refactor (`src/server.ts`)

**Files:**

- Modify: `src/server.ts`, `src/transport.ts`

- [ ] **Step 1: Create the context class in `src/server.ts`**

```typescript
export class FilesystemServerContext {
  constructor(
    public readonly mcp: McpServer,
    public readonly roots: RootsManager,
    public readonly resources: ResourceStore,
    public readonly resourcesHandle: ResourcesHandle,
  ) {}

  public async close(): Promise<void> {
    this.resourcesHandle.destroy();
    this.roots.destroy();
    logRouter.detachStdio();
    await this.mcp.close();
  }
}
```

- [ ] **Step 2: Update `createServer` to return `FilesystemServerContext`**

```typescript
export async function createServer(
  options: ServerOptions & { isInitialized?: () => boolean } = {},
): Promise<FilesystemServerContext> {
  // ... existing setup logic

  const ctx = new FilesystemServerContext(server, rootsManager, resourceStore, resourcesHandle);
  return ctx;
}
```

- [ ] **Step 3: Remove `WeakMap` singletons**
      Remove `rootsManagers`, `resourceHandles`, `getRootsManager` entirely from `src/server.ts`.

- [ ] **Step 4: Update usages in `src/transport.ts`**

```typescript
// Replace:
const { server: mcpServer } = await createServer(options);
const rootsManager = getRootsManager(mcpServer);

// With:
const serverCtx = await createServer(options);
const mcpServer = serverCtx.mcp;
const rootsManager = serverCtx.roots;

```

_(Apply to `startServer` and `createHttpSession`)_

- [ ] **Step 5: Run tests**

```bash
node scripts/tasks.mjs --quick

```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/transport.ts
git commit -m "refactor: introduce FilesystemServerContext to replace WeakMaps"

```
