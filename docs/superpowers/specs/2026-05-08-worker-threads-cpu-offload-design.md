# Worker-thread CPU offload for diff/patch tools

**Date:** 2026-05-08
**Status:** Approved (design); ready for implementation plan
**Scope:** Add a single-file, lazy worker pool that offloads pure-JS diff/patch
work above a size threshold. Wire into `diff_files`, `apply_patch`, `edit`,
and `search_and_replace` in one PR.

## Problem

Four tools call CPU-bound, pure-JS code from the [`diff`](https://www.npmjs.com/package/diff)
package on payloads up to `MAX_TEXT_FILE_SIZE` (default 10 MiB, env-tunable to
100 MiB). On the upper end these calls block the Node.js event loop for
seconds, stalling the MCP server's stdio JSON-RPC loop and any concurrent HTTP
sessions:

| Tool                 | Hotspot                                                |
| -------------------- | ------------------------------------------------------ |
| `diff_files`         | `structuredPatch` + `formatPatch` (`diff-files.ts`)    |
| `apply_patch`        | `parsePatch` + `applyPatch` (`apply-patch.ts`)         |
| `edit`               | `createTwoFilesPatch` (`edit-file.ts`)                 |
| `search_and_replace` | `createTwoFilesPatch` per-file (`replace-in-files.ts`) |

The remaining 14 tools are I/O-bound; the Node async I/O path already releases
the loop and worker threads would only add overhead. This design therefore
targets the four diff/patch sites only.

## Goals

1. Free the main event loop while large diff/patch operations run.
2. Zero regression for small payloads (the common case).
3. Observable behavior — error shapes, abort semantics, output bytes —
   indistinguishable from the inline path.
4. Bounded resource cost: lazy spawn, idle reclamation, hard cap on pool size.
5. Single dispatch point for any future CPU-bound task.

## Non-goals

- Offloading I/O (reads, stats, hashing of small files, RE2 search).
- Per-task worker scripts or multiple pools.
- Pre-warming, nested workers, `BroadcastChannel`, `postMessageToThread`.
- Sandboxing untrusted input via `resourceLimits` (out of scope).

## Architecture

Single file `src/lib/worker.ts` with a top-level `if (isMainThread)` branch.
The same compiled `dist/lib/worker.js` is loaded by
`new Worker(new URL(import.meta.url))`; `isMainThread === false` inside the
worker selects the dispatch loop.

```text
src/lib/worker.ts
├── if (isMainThread)
│     export type WorkerTaskName = 'diff' | 'formatPatch' | 'applyPatch' | 'diffLines'
│     export function shouldOffload(bytes: number): boolean
│     export function runInWorker<N>(name, payload, opts): Promise<TaskResult[N]>
│     export function shutdownWorkerPool(): Promise<void>
│     // internal: WorkerPool singleton, lifecycle, abort, idle sweep, error rehydration
└── else
      const handlers = {
        diff:        (p) => structuredPatch(...),
        formatPatch: (p) => formatPatch(...),
        applyPatch:  (p) => { parsePatch + applyPatch + stats },
        diffLines:   (p) => diffLines + createTwoFilesPatch,
      }
      parentPort.on('message', dispatchOne)
```

### Threshold gate

```ts
WORKER_OFFLOAD_THRESHOLD_BYTES = 256 * 1024; // env: FS_WORKER_OFFLOAD_THRESHOLD
```

`shouldOffload(bytes)` returns `false` below the threshold and when
`FS_DISABLE_WORKERS=1`. Tool handlers compute bytes from data they already
have (`stat.size`, `Buffer.byteLength(content)`); no extra reads.

### Pool sizing & lifecycle

```ts
WORKER_POOL_MAX = min(4, max(1, os.availableParallelism() - 1)); // env: FS_WORKER_POOL_MAX
WORKER_POOL_MIN = 0; // pure lazy
WORKER_IDLE_TIMEOUT_MS = 30_000; // env: FS_WORKER_IDLE_MS
WORKER_CANCEL_GRACE_MS = 500; // env: FS_WORKER_CANCEL_GRACE_MS
```

States: `STARTING → IDLE → BUSY → IDLE → TERMINATING → REMOVED`.

- One task per worker at a time; new requests beyond `WORKER_POOL_MAX` go to a
  parent-side FIFO queue.
- A single `setInterval(...).unref()` sweeps idle workers every 10 s.
- `shutdownWorkerPool()` is idempotent, called from the existing shutdown path
  in `src/server/bootstrap.ts`.
- `availableParallelism()` is used (not `os.cpus().length`) so the cap respects
  cgroup CPU limits in the Docker image.

### Concurrency model

Single task per worker. Cancellation kills exactly the right task via
`worker.terminate()`; head-of-line blocking is impossible because slow tasks
don't share a worker.

### Transfer semantics

**Structured clone, no `transferList`.** Reasons:

1. `diff` takes `string`. Strings are not transferable.
2. On a 10 MiB string, clone cost is ~30–50 ms while the diff itself takes
   1500–4000 ms — clone overhead is <2 % of the work.
3. `StructuredPatch` results are small; clone cost on the return path is
   negligible.
4. Avoids accidentally detaching `ArrayBuffer`s the parent reuses post-call.

This is documented inline in `worker.ts`.

### Request/response protocol

```ts
// parent → worker
{ id: number, name: WorkerTaskName, payload: TaskPayload[name] }

// worker → parent (success)
{ id: number, ok: true, value: TaskResult[name] }

// worker → parent (failure)
{ id: number, ok: false, error: SerializedError }
```

`SerializedError`:

```ts
type SerializedError =
  | { code: ErrorCode; message: string; path?: string; data?: unknown } // McpError
  | { code: 'UNKNOWN'; message: string; stack?: string }; // generic Error
```

Parent rehydrates: if `code` is a known `ErrorCode`, throws
`new McpError(code, message, path, data)`; otherwise throws `new Error` with
restored stack. The invariant — _callers cannot distinguish worker vs inline
errors_ — keeps existing tool-level error helpers and tests unchanged.

### Cancellation

1. Caller passes `signal: AbortSignal` (already standard in this codebase).
2. Pool registers a one-shot `'abort'` listener.
3. On abort: try a best-effort `{ id, cancel: true }` message (worker checks
   between tasks; cannot interrupt synchronous JS mid-task).
4. After `WORKER_CANCEL_GRACE_MS` (500 ms): `worker.terminate()`, drop the
   worker from the pool, reject task with `AbortError`. The pool spawns a
   fresh worker on next demand.

### HTTP-mode safety

The pool is a **process-level singleton** shared across HTTP sessions. Safe
because:

1. Workers do pure CPU work on payloads explicitly handed to them. They have
   no access to `RootsManager`, the `AsyncLocalStorage` allowed-directories
   state, bearer tokens, or filesystem paths. Path validation always runs in
   the main thread before `runInWorker`.
2. Worker handlers receive only the strings they need (`oldStr`, `newStr`,
   `patchText`) — no path metadata. Tasks complete before the next is handed
   in; workers don't retain task data after `postMessage`.
3. `WORKER_POOL_MAX = 4` is a process-global resource budget — the right
   level. Per-session pools would inflate RSS without benefit.

This rationale is repeated as a comment block at the top of `worker.ts` so the
security model is visible at the integration point.

## Tool integration

All four tools follow the same pattern: locate the existing `diff`-package
call, gate it by payload size, dispatch to the worker if above threshold.

### `diff_files` (`src/tools/diff-files.ts`)

```ts
const totalBytes = oldStat.size + newStat.size;
const patch = shouldOffload(totalBytes)
  ? await runInWorker(
      'diff',
      { oldStr, newStr, oldHeader, newHeader },
      { signal }
    )
  : structuredPatch(oldHeader, newHeader, oldStr, newStr, '', '');

const formatted = shouldOffload(totalBytes)
  ? await runInWorker('formatPatch', { patch }, { signal })
  : formatPatch(patch);
```

### `apply_patch` (`src/tools/apply-patch.ts`)

`parsePatch` + `applyPatch` are combined into a single `'applyPatch'` task to
avoid a round trip and keep the parsed `StructuredPatch` heap-local. Gate by
`source.length + patchText.length`.

### `edit` (`src/tools/edit-file.ts`)

`createTwoFilesPatch` is the only pure-JS hotspot (the literal-replacement
loop is fast). Gate by
`Buffer.byteLength(originalContent) + Buffer.byteLength(modifiedContent)` →
task `'diffLines'` returns `{ unifiedDiff }`.

### `search_and_replace` (`src/tools/replace-in-files.ts`)

Per-file gating with the same threshold. The existing
`processInParallel(..., REPLACE_CONCURRENCY = 8)` naturally fans out to the
pool, which serves up to `WORKER_POOL_MAX` concurrently and queues the rest.

## Error handling invariant

> From the caller's perspective, `runInWorker(name, payload)` is observably
> indistinguishable from running the inline implementation, except for timing.

- Same `McpError` instances (rehydrated with `code`, `path`, `data`).
- Same generic `Error` shape for unexpected throws.
- Same `AbortSignal` semantics (`AbortError`).
- Same per-tool timeouts via `runInWorker(..., { timeoutMs })`.
- Worker crash → `McpError(ErrorCode.INTERNAL, 'Worker terminated unexpectedly')`.
  The tool's existing top-level `try/catch` converts to `isError: true`.
  No special-casing in tool handlers.

## What we explicitly do not do

- No `SHARE_ENV`. Workers receive a snapshot of `process.env` at spawn.
- No `BroadcastChannel` or `postMessageToThread`. Single port per worker.
- No `resourceLimits`. Diffs are bounded by `MAX_TEXT_FILE_SIZE`; capping the
  V8 heap inside the worker would only convert valid diffs into OOM crashes.
- No nested workers. Worker handlers never call `runInWorker`.
- No worker path in tests by default. `__tests__/helpers.ts`'s `createTestEnv`
  sets `FS_DISABLE_WORKERS=1`. Worker behavior is exercised by dedicated tests.

## Testing strategy

### `__tests__/unit/worker.test.ts` (worker enabled)

- spawns up to `WORKER_POOL_MAX`, queues beyond
- reuses idle workers across tasks
- reclaims idle workers after `WORKER_IDLE_TIMEOUT_MS`
- rejects with `AbortError` when signal aborts before completion
- rejects with `WORKER_CRASHED` when worker exits unexpectedly
- rehydrates `McpError` with `code` / `path` / `data` preserved
- `shutdownWorkerPool()` terminates all workers and is idempotent
- `FS_DISABLE_WORKERS=1` makes `runInWorker` throw — fail loud on misuse
- `shouldOffload()` honors threshold and disable switch

Each test ends with `await shutdownWorkerPool()` to avoid leaking workers.

### `__tests__/tools/worker-offload.test.ts` (parity)

For each of the 4 integrated tools, run a fixture above the threshold with
workers enabled and again with `FS_DISABLE_WORKERS=1`. Assert byte-identical
structured output. Regression bedrock for behavioral parity.

### `__tests__/dist-runtime.test.ts`

Add one assertion: `dist/lib/worker.js` exists and is `new Worker`-loadable.

### Existing suite

Unchanged. Inline path exercised because `createTestEnv` sets
`FS_DISABLE_WORKERS=1`.

## Static checks

- **knip:** all four exports (`runInWorker`, `shouldOffload`,
  `shutdownWorkerPool`, `WorkerTaskName`) consumed by tools and bootstrap →
  no unused-export warnings.
- **eslint:** dual-mode top-level `if (isMainThread) { ... } else { ... }`
  passes existing config.
- **type-check:** `WorkerTaskName`-keyed mapped types `TaskPayload` and
  `TaskResult` give type-safe `runInWorker<'diff'>(...)` returning
  `StructuredPatch`. No `any`.

## Build & packaging

- `dist/lib/worker.js` produced by the existing `tsc -p tsconfig.json`. No
  change to `package.json` `files` (`dist` is already shipped wholesale).
- `new Worker(new URL(import.meta.url))` resolves at runtime to the actual
  `dist/lib/worker.js` URL when running the published package, and to the
  `tsx`-loaded `.ts` URL during tests. Both work because `tsx` registers as a
  loader for worker threads as well.

## Constants summary (added to `src/lib/constants.ts`)

| Constant                         | Default        | Env override                      |
| -------------------------------- | -------------- | --------------------------------- |
| `WORKER_POOL_MAX`                | min(4, cpus−1) | `FS_WORKER_POOL_MAX`              |
| `WORKER_IDLE_TIMEOUT_MS`         | 30 000         | `FS_WORKER_IDLE_MS`               |
| `WORKER_OFFLOAD_THRESHOLD_BYTES` | 262 144        | `FS_WORKER_OFFLOAD_THRESHOLD`     |
| `WORKER_CANCEL_GRACE_MS`         | 500            | `FS_WORKER_CANCEL_GRACE_MS`       |
| `FS_DISABLE_WORKERS`             | unset          | `FS_DISABLE_WORKERS=1` to disable |

## Files

### Added

- `src/lib/worker.ts`
- `__tests__/unit/worker.test.ts`
- `__tests__/tools/worker-offload.test.ts`

### Modified

- `src/tools/diff-files.ts`, `src/tools/edit-file.ts`,
  `src/tools/apply-patch.ts`, `src/tools/replace-in-files.ts`
- `src/lib/constants.ts` (5 new constants)
- `src/server/bootstrap.ts` (call `shutdownWorkerPool()` in shutdown path)
- `__tests__/helpers.ts` (`createTestEnv` sets `FS_DISABLE_WORKERS=1`)
- `__tests__/dist-runtime.test.ts` (assert `dist/lib/worker.js` exists)

### Unchanged

- `__tests__/contract.test.ts` — no new tools, no annotation changes.
- `package.json`, `tsconfig.json` — `src/lib/**` is already built and shipped.

## Open risks

1. **`tsx` worker-thread loader compatibility.** Verified to work for current
   `tsx` versions, but pin behavior in the unit-test setup. Implementation
   plan should include a smoke test that creates one worker before any tool
   integration to fail fast if the loader is broken.
2. **`diff` package memory inside workers.** Each worker carries the `diff`
   module on its heap (~few MiB). With cap 4 this is bounded. Documented as
   acceptable cost of the single-file design.
3. **Behavior on Windows symlinks / drive letters.** Unrelated to workers
   directly, but `new URL(import.meta.url)` must be used (not raw paths) to
   avoid the Windows `createRequire` drive-letter pitfall noted in user
   memory.
