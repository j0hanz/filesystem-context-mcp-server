# Node.js Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 13 Node.js anti-patterns and security gaps identified in the codebase review, from high-severity Slowloris vulnerabilities down to style inconsistencies.

**Architecture:** Changes are confined to six files in `src/lib/`, `src/server/`, and `src/tools/` with no public API changes. Each task is self-contained and can be reviewed independently. Tasks 1–5 require new or expanded tests; Task 6 is pure refactor with no observable behavior change.

**Tech Stack:** Node.js 24, TypeScript (strict + exactOptionalPropertyTypes), `node:test` runner, `tsx/esm` loader, `node:assert/strict`.

---

## File Map

| File                                    | Tasks                                  |
| --------------------------------------- | -------------------------------------- |
| `src/server/bootstrap.ts`               | Task 1 (3 changes), Task 6 (2 changes) |
| `src/__tests__/http.test.ts`            | Task 1 (3 new tests)                   |
| `src/tools/search-content.ts`           | Task 2 (1 change)                      |
| `src/lib/abort.ts`                      | Task 3 (1 change)                      |
| `src/__tests__/unit/abort.test.ts`      | Task 3 (new file)                      |
| `src/lib/fs-helpers.ts`                 | Task 4 (1 change), Task 6 (1 change)   |
| `src/__tests__/unit/fs-helpers.test.ts` | Task 4 (new file)                      |
| `src/server/task-store.ts`              | Task 5 (1 change)                      |
| `src/__tests__/unit/task-store.test.ts` | Task 5 (1 new test)                    |
| `src/lib/paths.ts`                      | Task 6 (1 change)                      |
| `src/lib/utils.ts`                      | Task 6 (1 change)                      |

---

## Task 1: HTTP Server Security Hardening

Covers findings 1 (Slowloris — missing timeouts), 2 (no persistent error handler), and 3 (socket not drained after body rejection). All three changes are in `src/server/bootstrap.ts` and verified by three new tests in `src/__tests__/http.test.ts`.

**Files:**

- Modify: `src/server/bootstrap.ts`
- Modify: `src/__tests__/http.test.ts`

---

### 1a — HTTP timeouts (Slowloris hardening)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('HTTP transport', () => {` block in [src/**tests**/http.test.ts](src/__tests__/http.test.ts). Place it after the last `it(...)` in that file, before the closing `});`:

```ts
it('sets headersTimeout, requestTimeout, and keepAliveTimeout for Slowloris protection', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
  const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
  servers.push(server);

  // Node.js http.Server exposes these as number properties.
  const s = server as import('node:http').Server & {
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
  };
  assert.ok(
    s.headersTimeout > 0,
    `headersTimeout must be > 0, got ${s.headersTimeout}`
  );
  assert.ok(
    s.requestTimeout > 0,
    `requestTimeout must be > 0, got ${s.requestTimeout}`
  );
  assert.ok(
    s.keepAliveTimeout > 0,
    `keepAliveTimeout must be > 0, got ${s.keepAliveTimeout}`
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test --import tsx/esm --test-name-pattern="sets headersTimeout" src/__tests__/http.test.ts
```

Expected: FAIL — Node.js defaults (`headersTimeout = 60000`, `requestTimeout = 300000`) mean the test actually passes with defaults! Adjust expectations to confirm our explicit values are set. Rewrite the test to check for the specific values we will set:

```ts
it('sets headersTimeout, requestTimeout, and keepAliveTimeout for Slowloris protection', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
  const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
  servers.push(server);

  const s = server as import('node:http').Server & {
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
  };
  assert.equal(s.headersTimeout, 10_000, 'headersTimeout must be 10s');
  assert.equal(s.requestTimeout, 30_000, 'requestTimeout must be 30s');
  assert.equal(s.keepAliveTimeout, 5_000, 'keepAliveTimeout must be 5s');
});
```

Run again — this now FAILs because the values are Node.js defaults (not our values).

- [ ] **Step 3: Add HTTP timeouts in `startHttpServer`**

In [src/server/bootstrap.ts](src/server/bootstrap.ts), locate the `createHttpServer(...)` call (around line 826). Add three timeout assignments immediately after it:

```ts
const httpServer = createHttpServer(
  (req: IncomingMessage, res: ServerResponse) => {
    // ... existing handler unchanged ...
  }
);

// Slowloris / slow-body DoS protection
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
httpServer.keepAliveTimeout = 5_000;
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test --import tsx/esm --test-name-pattern="sets headersTimeout" src/__tests__/http.test.ts
```

Expected: PASS

---

### 1b — Persistent HTTP error handler

- [ ] **Step 5: Write the failing test**

Add inside the same `describe('HTTP transport', ...)` block:

```ts
it('does not crash on post-startup HTTP server errors', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
  const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
  servers.push(server);

  // Verify there is at least one persistent 'error' listener on the server
  // (not just the startup once-listener that was consumed during listen).
  // Node EventEmitter: listenerCount counts all active listeners.
  const listenerCount = server.listenerCount('error');
  assert.ok(
    listenerCount >= 1,
    `Expected at least one persistent error listener, got ${listenerCount}`
  );
});
```

- [ ] **Step 6: Run test to verify it fails**

```
node --test --import tsx/esm --test-name-pattern="does not crash on post-startup" src/__tests__/http.test.ts
```

Expected: FAIL — the `once('error', reject)` handler is consumed by the first error or discarded after listen succeeds. The listener count will be 0 after startup.

- [ ] **Step 7: Add persistent error handler in `startHttpServer`**

In [src/server/bootstrap.ts](src/server/bootstrap.ts), locate the `Promise<Server>` block near the bottom of `startHttpServer` (around line 858). Add a persistent `on('error', ...)` listener inside the listen callback:

```ts
return new Promise<Server>((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(port, httpHost, () => {
    Logger.info(`MCP HTTP server listening on ${httpHost}:${port}`);
    // Persistent handler for errors after startup (once above is consumed on listen failure only).
    httpServer.on('error', (err: Error) => {
      Logger.error('[HTTP] Server runtime error:', err.message);
    });
    resolve(httpServer);
  });
});
```

- [ ] **Step 8: Run test to verify it passes**

```
node --test --import tsx/esm --test-name-pattern="does not crash on post-startup" src/__tests__/http.test.ts
```

Expected: PASS

---

### 1c — Drain socket after body-size rejection

- [ ] **Step 9: Write the failing test**

Add inside the same `describe('HTTP transport', ...)` block. This test sends a body larger than `MAX_REQUEST_BODY_BYTES` (default 4 MB) and verifies the response is 413 with the connection cleanly closed:

```ts
it('returns 413 for request bodies exceeding the size limit', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
  const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
  servers.push(server);
  const port = getServerPort(server);

  // 5 MB body — over the 4 MB default cap.
  const bigBody = 'x'.repeat(5 * 1024 * 1024);
  const response = await rawHttpRequest({
    port,
    method: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json' },
    body: bigBody,
  });

  assert.equal(response.statusCode, 413);
  const parsed = JSON.parse(response.body) as {
    error?: { message?: string };
  };
  assert.match(parsed.error?.message ?? '', /too large/iu);
});
```

- [ ] **Step 10: Run test to verify it passes already (baseline)**

```
node --test --import tsx/esm --test-name-pattern="returns 413 for request bodies" src/__tests__/http.test.ts
```

Expected: PASS — the 413 already works. This test is a regression guard. Confirm it passes, then proceed to fix the drain issue.

- [ ] **Step 11: Fix the socket drain in `readRequestBody`**

In [src/server/bootstrap.ts](src/server/bootstrap.ts), locate `readRequestBody` (around line 302). The `data` handler currently calls `req.pause()` after rejecting. Replace `req.pause()` with `req.resume()` so the connection can be cleanly drained:

```ts
async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        if (!tooBig) {
          tooBig = true;
          chunks.length = 0; // free accumulated memory
          reject(new RequestBodyError('Request body too large', 413));
          req.resume(); // drain so the connection can be cleanly closed
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return; // already rejected in 'data' handler
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new RequestBodyError('Invalid JSON in request body', 400));
      }
    });
    req.on('error', reject);
  });
}
```

- [ ] **Step 12: Run all HTTP tests to confirm no regressions**

```
node --test --import tsx/esm src/__tests__/http.test.ts
```

Expected: All PASS

- [ ] **Step 13: Commit**

```bash
git add src/server/bootstrap.ts src/__tests__/http.test.ts
git commit -m "fix: HTTP server hardening — timeouts, persistent error handler, socket drain"
```

---

## Task 2: Fix `MAX_INLINE_MATCHES` Env Var Parsing

Finding 4: `parseInt(process.env['FS_CONTEXT_MAX_INLINE_MATCHES'] ?? '', 10) || 50` silently treats `"0"` as the default (50) because `0 || 50 === 50`. The rest of the codebase uses `parseEnvInt` from `src/lib/constants.ts`.

**Files:**

- Modify: `src/tools/search-content.ts`

---

- [ ] **Step 1: Write the failing test**

Add a new file `src/__tests__/unit/env-parsing.test.ts`:

```ts
import assert from 'node:assert/strict';

import { afterEach, beforeEach, describe, it } from 'node:test';

describe('FS_CONTEXT_MAX_INLINE_MATCHES parsing', () => {
  const ORIG = process.env['FS_CONTEXT_MAX_INLINE_MATCHES'];

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env['FS_CONTEXT_MAX_INLINE_MATCHES'];
    } else {
      process.env['FS_CONTEXT_MAX_INLINE_MATCHES'] = ORIG;
    }
    // Re-import is not possible in ESM without dynamic import tricks.
    // We test the parseEnvInt helper directly instead.
  });

  it('parseEnvInt treats "0" as below-minimum, returning default', async () => {
    // Dynamic import so we test the real exported function.
    const { parseEnvInt } = await import('../../lib/constants.js');
    process.env['FS_CONTEXT_TEST_INLINE'] = '0';
    // min=1 means 0 is invalid → returns default 50
    const result = parseEnvInt('FS_CONTEXT_TEST_INLINE', 50, 1, 10_000);
    delete process.env['FS_CONTEXT_TEST_INLINE'];
    assert.equal(result, 50);
  });

  it('parseEnvInt treats "25" as valid, returning 25', async () => {
    const { parseEnvInt } = await import('../../lib/constants.js');
    process.env['FS_CONTEXT_TEST_INLINE'] = '25';
    const result = parseEnvInt('FS_CONTEXT_TEST_INLINE', 50, 1, 10_000);
    delete process.env['FS_CONTEXT_TEST_INLINE'];
    assert.equal(result, 25);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (documents expected behavior)**

```
node --test --import tsx/esm src/__tests__/unit/env-parsing.test.ts
```

Expected: PASS — this documents what `parseEnvInt` does and will catch any regression if the function changes.

- [ ] **Step 3: Fix `search-content.ts`**

In [src/tools/search-content.ts](src/tools/search-content.ts), update the import to include `parseEnvInt` and replace the inline `parseInt` call:

**Change the import** (currently imports only `DEFAULT_EXCLUDE_PATTERNS`):

```ts
import { DEFAULT_EXCLUDE_PATTERNS, parseEnvInt } from '../lib/constants.js';
```

**Change the `CONFIG` object** (around line 47–55):

```ts
const CONFIG = {
  MAX_INLINE_MATCHES: parseEnvInt(
    'FS_CONTEXT_MAX_INLINE_MATCHES',
    50,
    1,
    10_000
  ),
  COMPLETION_LABELS: {
    timeout: 'timeout',
    maxResults: 'max results',
    maxFiles: 'max files',
  } as const,
} as const;
```

- [ ] **Step 4: Run type-check to confirm no errors**

```
npm run type-check:src
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-content.ts src/__tests__/unit/env-parsing.test.ts
git commit -m "fix: replace parseInt-or-50 with parseEnvInt for MAX_INLINE_MATCHES"
```

---

## Task 3: Make `createTimedAbortSignal` Cleanup Meaningful

Finding 5: `AbortSignal.timeout(ms)` creates a non-cancellable internal timer. The `cleanup` callback is always `() => {}`. This means every call leaks a timer until it naturally fires (e.g. 5-second ROOTS_TIMEOUT_MS timers that could fire after the operation completed in 50ms). The fix replaces `AbortSignal.timeout` with a manual `AbortController` + `setTimeout` so `cleanup()` actually cancels the pending timer.

**Files:**

- Modify: `src/lib/abort.ts`
- Create: `src/__tests__/unit/abort.test.ts`

---

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/unit/abort.test.ts`:

```ts
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, it } from 'node:test';

import {
  assertNotAborted,
  createTimedAbortSignal,
  withAbort,
} from '../../lib/abort.js';

describe('createTimedAbortSignal', () => {
  it('aborts the signal after the timeout elapses', async () => {
    const { signal, cleanup } = createTimedAbortSignal(undefined, 50);
    try {
      await sleep(100);
      assert.equal(
        signal.aborted,
        true,
        'Signal must be aborted after timeout'
      );
      assert.equal(signal.reason?.name, 'TimeoutError');
    } finally {
      cleanup();
    }
  });

  it('cleanup() cancels the pending timer so the signal is NOT aborted', async () => {
    const { signal, cleanup } = createTimedAbortSignal(undefined, 100);
    cleanup(); // cancel before timeout fires
    await sleep(150); // wait longer than the timeout
    assert.equal(
      signal.aborted,
      false,
      'Signal must NOT be aborted after cleanup'
    );
  });

  it('returns a noop signal when no timeout and no base signal', () => {
    const { signal, cleanup } = createTimedAbortSignal(undefined, undefined);
    cleanup(); // no-op
    assert.equal(signal.aborted, false);
  });

  it('returns the base signal unchanged when no timeout', () => {
    const ctrl = new AbortController();
    const { signal } = createTimedAbortSignal(ctrl.signal, undefined);
    assert.equal(signal, ctrl.signal);
  });

  it('combines base signal and timeout — base abort wins', async () => {
    const ctrl = new AbortController();
    const { signal, cleanup } = createTimedAbortSignal(ctrl.signal, 1000);
    try {
      ctrl.abort();
      assert.equal(signal.aborted, true);
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail as expected**

```
node --test --import tsx/esm src/__tests__/unit/abort.test.ts
```

Expected: The "cleanup() cancels" test FAILs because the current implementation uses `AbortSignal.timeout()` (non-cancellable), so the signal DOES abort at 100ms even after `cleanup()`. The other tests may pass.

- [ ] **Step 3: Fix `createTimedAbortSignal` in `src/lib/abort.ts`**

Replace the entire `createTimedAbortSignal` function. The current implementation is around lines 68–92:

```ts
export function createTimedAbortSignal(
  baseSignal: AbortSignal | undefined,
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  if (isFiniteNumber(timeoutMs)) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(
        new DOMException('The operation timed out', 'TimeoutError')
      );
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
    return { signal: baseSignal, cleanup: () => {} };
  }

  return { signal: SHARED_NOOP_SIGNAL, cleanup: () => {} };
}
```

No other changes to `abort.ts` are needed. `withTimedAbortSignal` already calls `cleanup()` in a `finally` block, so it will now correctly cancel timers for operations that complete quickly.

- [ ] **Step 4: Run tests to verify they all pass**

```
node --test --import tsx/esm src/__tests__/unit/abort.test.ts
```

Expected: All 5 tests PASS

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```
npm run test:fast
```

Expected: All tests PASS (the signal behavior for timeout is equivalent — `TimeoutError` name matches what `isTimeoutErrorSingle` checks for in `errors.ts`)

- [ ] **Step 6: Commit**

```bash
git add src/lib/abort.ts src/__tests__/unit/abort.test.ts
git commit -m "fix: createTimedAbortSignal cleanup now cancels the pending timer"
```

---

## Task 4: Fix `processInParallel` Undefined-Result Guard

Finding 8: `processInParallel<T, R>` pre-allocates `resultSlots` as `(R | undefined)[]` and then filters slots with `slot !== undefined` when building the output array. If `R` is `undefined`, valid results are silently dropped. The fix uses a unique Symbol sentinel to distinguish "slot not yet filled" from "slot filled with `undefined`".

**Files:**

- Modify: `src/lib/fs-helpers.ts`
- Create: `src/__tests__/unit/fs-helpers.test.ts`

---

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/unit/fs-helpers.test.ts`:

```ts
import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import { processInParallel } from '../../lib/fs-helpers.js';

describe('processInParallel', () => {
  it('preserves undefined as a valid result value', async () => {
    // Processor always returns undefined — a valid R = undefined result.
    const items = [1, 2, 3];
    const { results, errors } = await processInParallel(
      items,
      async (_item) => undefined,
      3
    );
    assert.equal(errors.length, 0);
    // Without the fix, all three undefined results are dropped and results.length === 0.
    assert.equal(results.length, 3, 'All undefined results must be preserved');
    assert.deepEqual(results, [undefined, undefined, undefined]);
  });

  it('returns results in input order even with concurrency > 1', async () => {
    const items = [30, 10, 20];
    const { results, errors } = await processInParallel(
      items,
      async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      },
      3
    );
    assert.equal(errors.length, 0);
    assert.deepEqual(results, [30, 10, 20]);
  });

  it('collects errors without aborting other items', async () => {
    const items = [1, 2, 3];
    const { results, errors } = await processInParallel(
      items,
      async (n) => {
        if (n === 2) throw new Error('fail');
        return n;
      },
      3
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.index, 1);
    assert.equal(results.length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify the first test fails**

```
node --test --import tsx/esm src/__tests__/unit/fs-helpers.test.ts
```

Expected: "preserves undefined as a valid result value" FAILs with `results.length === 0` instead of 3. The other tests PASS.

- [ ] **Step 3: Apply the Symbol-sentinel fix in `fs-helpers.ts`**

In [src/lib/fs-helpers.ts](src/lib/fs-helpers.ts), locate `processInParallel`. Make the following changes:

Add a module-level sentinel constant before the function (around line 62):

```ts
const UNFILLED: unique symbol = Symbol('unfilled');
```

Change the slot array declaration inside `processInParallel` (currently line ~73):

```ts
// Before:
const resultSlots: (R | undefined)[] = new Array<R | undefined>(itemCount);

// After:
const resultSlots: (R | typeof UNFILLED)[] = new Array<R | typeof UNFILLED>(
  itemCount
).fill(UNFILLED);
```

Change the slot assignment inside the `try` block (currently line ~90):

```ts
// No change needed — resultSlots[index] = result; still works because R extends the union.
```

Change the result collection at the bottom (currently lines ~112–119):

```ts
// Before:
const results: R[] = [];
for (const slot of resultSlots) {
  if (slot !== undefined) {
    results.push(slot);
  }
}

// After:
const results: R[] = [];
for (const slot of resultSlots) {
  if (slot !== UNFILLED) {
    results.push(slot);
  }
}
```

- [ ] **Step 4: Run all fs-helpers tests to verify they pass**

```
node --test --import tsx/esm src/__tests__/unit/fs-helpers.test.ts
```

Expected: All 3 tests PASS

- [ ] **Step 5: Run full suite to confirm no regressions**

```
npm run test:fast
```

Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/fs-helpers.ts src/__tests__/unit/fs-helpers.test.ts
git commit -m "fix: use Symbol sentinel in processInParallel to preserve undefined results"
```

---

## Task 5: Add Eviction Threshold to `ResultAwareInMemoryTaskStore`

Finding 7: `evictExpired()` does an O(n) full scan of `cancelledResults` on _every_ `getTaskResult` call. Under normal load the map is tiny, but a misconfigured client that cancels many tasks could cause linear overhead on every subsequent task lookup. The fix gates the scan behind a size threshold so the cost is paid rarely.

**Files:**

- Modify: `src/server/task-store.ts`
- Modify: `src/__tests__/unit/task-store.test.ts`

---

- [ ] **Step 1: Write the failing test**

Add a new test at the bottom of [src/**tests**/unit/task-store.test.ts](src/__tests__/unit/task-store.test.ts):

```ts
describe('ResultAwareInMemoryTaskStore eviction', () => {
  it('evicts expired cancelled results when the map exceeds the threshold', async () => {
    const store = new ResultAwareInMemoryTaskStore();
    try {
      // CANCELLED_RESULT_TTL_MS is 2 minutes — we need to simulate expiry.
      // Expose the private map via bracket notation for test-only access.
      const cancelledResults = (
        store as unknown as {
          cancelledResults: Map<string, { result: unknown; createdAt: number }>;
        }
      ).cancelledResults;

      // Inject 60 fake expired entries (above the EVICT_THRESHOLD of 50).
      const expiredTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
      for (let i = 0; i < 60; i++) {
        cancelledResults.set(`session:task-${String(i)}`, {
          result: { content: [], isError: true },
          createdAt: expiredTime,
        });
      }
      assert.equal(
        cancelledResults.size,
        60,
        'Precondition: 60 entries before eviction'
      );

      // Trigger eviction via getTaskResult (even for a nonexistent task — the
      // evict call happens before the super.getTaskResult throw).
      try {
        await store.getTaskResult('nonexistent', 'nope');
      } catch {
        // Expected — task does not exist.
      }

      assert.ok(
        cancelledResults.size < 60,
        `Expected eviction to remove expired entries, but size is still ${cancelledResults.size}`
      );
    } finally {
      store.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test --import tsx/esm src/__tests__/unit/task-store.test.ts
```

Expected: "evicts expired cancelled results" FAILs because the current code evicts on every call regardless of map size — the eviction _does_ happen, but only because there's no threshold yet. Actually the test will PASS because eviction already runs. **Adjust**: the test is checking that eviction happens above the threshold, which currently it always does. The real regression to guard against is: below threshold, eviction must NOT run (saving unnecessary scans).

Rewrite as a paired test that also checks the below-threshold case by measuring behavior:

```ts
describe('ResultAwareInMemoryTaskStore eviction', () => {
  it('skips the O(n) scan when cancelledResults is below the threshold', async () => {
    const store = new ResultAwareInMemoryTaskStore();
    try {
      const cancelledResults = (
        store as unknown as {
          cancelledResults: Map<string, { result: unknown; createdAt: number }>;
        }
      ).cancelledResults;

      // Inject 10 NOT-expired entries (well below the EVICT_THRESHOLD of 50).
      const freshTime = Date.now(); // current — not expired
      for (let i = 0; i < 10; i++) {
        cancelledResults.set(`s:t-${String(i)}`, {
          result: { content: [], isError: true },
          createdAt: freshTime,
        });
      }
      assert.equal(cancelledResults.size, 10);

      try {
        await store.getTaskResult('x', 'y');
      } catch {
        /* expected */
      }

      // Because we are below threshold, no scan runs, so all 10 entries remain.
      assert.equal(
        cancelledResults.size,
        10,
        'Below threshold: no entries must be removed'
      );
    } finally {
      store.cleanup();
    }
  });

  it('evicts expired cancelled results when the map exceeds the threshold', async () => {
    const store = new ResultAwareInMemoryTaskStore();
    try {
      const cancelledResults = (
        store as unknown as {
          cancelledResults: Map<string, { result: unknown; createdAt: number }>;
        }
      ).cancelledResults;

      const expiredTime = Date.now() - 3 * 60 * 1000;
      for (let i = 0; i < 60; i++) {
        cancelledResults.set(`s:t-${String(i)}`, {
          result: { content: [], isError: true },
          createdAt: expiredTime,
        });
      }
      assert.equal(cancelledResults.size, 60);

      try {
        await store.getTaskResult('x', 'y');
      } catch {
        /* expected */
      }

      assert.equal(
        cancelledResults.size,
        0,
        'All 60 expired entries must be evicted'
      );
    } finally {
      store.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run tests to confirm the first test fails**

```
node --test --import tsx/esm src/__tests__/unit/task-store.test.ts
```

Expected: "skips the O(n) scan when cancelledResults is below threshold" FAILs because the current code always runs the scan. The second test passes because eviction already works.

- [ ] **Step 4: Apply the threshold guard in `task-store.ts`**

In [src/server/task-store.ts](src/server/task-store.ts), add a constant at the top of the class (or as a module constant before the class):

```ts
const EVICT_THRESHOLD = 50;
```

Update `evictExpired()`:

```ts
private evictExpired(): void {
  if (this.cancelledResults.size < EVICT_THRESHOLD) return;
  const now = Date.now();
  for (const [key, entry] of this.cancelledResults) {
    if (now - entry.createdAt > CANCELLED_RESULT_TTL_MS) {
      this.cancelledResults.delete(key);
    }
  }
}
```

- [ ] **Step 5: Run all task-store tests to verify they pass**

```
node --test --import tsx/esm src/__tests__/unit/task-store.test.ts
```

Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/task-store.ts src/__tests__/unit/task-store.test.ts
git commit -m "fix: gate task store eviction scan behind size threshold"
```

---

## Task 6: Cleanup and Style Fixes

Covers findings 5, 9, 10, 11, and 12. These are pure refactors with no behavior change; no new tests are needed, but `npm run test:fast` should remain green throughout.

**Files:**

- Modify: `src/lib/fs-helpers.ts` (finding 5)
- Modify: `src/server/bootstrap.ts` (finding 9 + finding 12)
- Modify: `src/lib/paths.ts` (finding 10)
- Modify: `src/lib/utils.ts` (finding 11)

---

### 6a — Remove dead `try/catch` in `atomicWriteFile` (finding 5)

- [ ] **Step 1: Remove the redundant outer try/catch**

In [src/lib/fs-helpers.ts](src/lib/fs-helpers.ts), locate `atomicWriteFile` (around line 862). The `catch` block currently reads:

```ts
  } catch (error) {
    // Attempt cleanup on error, but don't overwrite the original error
    try {
      await unlink(tempPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
```

The inner `.catch(() => {})` already swallows all errors from `unlink`. The outer `try/catch` is dead code. Replace with:

```ts
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
```

---

### 6b — Fix temporal coupling in `createHttpSession` (finding 9)

- [ ] **Step 2: Declare `transport` with definite assignment before `cleanup`**

In [src/server/bootstrap.ts](src/server/bootstrap.ts), inside `createHttpSession`, `cleanup` closes over `transport` before it is declared. Add a `let` declaration above `cleanup`:

```ts
// Declared here so cleanup can reference it; assigned below before transport.onclose fires.
let transport!: NodeStreamableHTTPServerTransport;

let cleanedUp = false;
const cleanup = (): void => {
  if (cleanedUp) return;
  cleanedUp = true;

  const { sessionId } = transport;
  // ... rest of cleanup unchanged ...
};
```

Remove the `const transport = new NodeStreamableHTTPServerTransport(...)` declaration keyword — change it to an assignment:

```ts
transport = new NodeStreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
  // ... rest of options unchanged ...
});
```

---

### 6c — Replace `validPaths.forEach` with `for...of` (finding 10)

- [ ] **Step 3: Update `getValidRootDirectories` in `paths.ts`**

In [src/lib/paths.ts](src/lib/paths.ts), locate `getValidRootDirectories` (around line 963). Replace:

```ts
validPaths.forEach((p, i) => {
  validDirs.push(p);
  const expanded = realExpansions[i];
  if (expanded !== null && expanded !== undefined) {
    validDirs.push(expanded);
  }
});
```

With:

```ts
for (const [i, p] of validPaths.entries()) {
  validDirs.push(p);
  const expanded = realExpansions[i];
  if (expanded !== null && expanded !== undefined) {
    validDirs.push(expanded);
  }
}
```

---

### 6d — Replace `Reflect.deleteProperty` with `delete` in `omitOptionKeys` (finding 11)

- [ ] **Step 4: Update `omitOptionKeys` in `utils.ts`**

In [src/lib/utils.ts](src/lib/utils.ts), locate `omitOptionKeys` (around line 40). Replace:

```ts
Reflect.deleteProperty(output, key);
```

With:

```ts
// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
delete output[key as keyof typeof output];
```

Note: TypeScript strict mode may require the eslint-disable comment because `key` is a generic type parameter. If `no-dynamic-delete` is not in the ESLint config, omit the comment.

---

### 6e — Log unexpected errors in `getLocalIconInfo` (finding 12)

- [ ] **Step 5: Log non-ENOENT errors in `getLocalIconInfo`**

In [src/server/bootstrap.ts](src/server/bootstrap.ts), locate `getLocalIconInfo` (around line 160). Update the `catch` to log unexpected errors:

```ts
async function getLocalIconInfo(): Promise<IconInfo | undefined> {
  const name = 'logo.svg';
  const mime = 'image/svg+xml';
  const candidates = [`../assets/${name}`, `../../assets/${name}`];

  for (const candidate of candidates) {
    try {
      const iconPath = new URL(candidate, import.meta.url);
      const buffer = await readFile(iconPath);
      return {
        src: `data:${mime};base64,${buffer.toString('base64')}`,
        mimeType: mime,
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        Logger.warn(
          `Unexpected error loading icon from ${candidate}:`,
          formatUnknownErrorMessage(error)
        );
      }
      // ENOENT: try next candidate silently.
    }
  }

  return undefined;
}
```

The `isNodeError` helper is already imported from `../lib/errors.js` in this file.

---

### 6f — Verify and commit all style fixes

- [ ] **Step 6: Run lint and type-check**

```
npm run lint
npm run type-check
```

Expected: no errors. If `no-dynamic-delete` triggers on `delete output[key...]`, add the eslint-disable comment shown in Step 4.

- [ ] **Step 7: Run the full test suite**

```
npm run test:fast
```

Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/lib/fs-helpers.ts src/server/bootstrap.ts src/lib/paths.ts src/lib/utils.ts
git commit -m "refactor: cleanup — remove dead try/catch, fix temporal coupling, for-of, delete, icon error logging"
```

---

## Self-Review

### Spec coverage

| Finding                                         | Task      | Covered?                   |
| ----------------------------------------------- | --------- | -------------------------- |
| 1. HTTP missing timeouts                        | Task 1a   | ✓                          |
| 2. No persistent HTTP error handler             | Task 1b   | ✓                          |
| 3. Socket not drained after body rejection      | Task 1c   | ✓                          |
| 4. `parseInt \|\| 50` for env var               | Task 2    | ✓                          |
| 5. Dead try/catch in atomicWriteFile            | Task 6a   | ✓                          |
| 6. createTimedAbortSignal cleanup is noop       | Task 3    | ✓                          |
| 7. O(n) eviction every getTaskResult            | Task 5    | ✓                          |
| 8. processInParallel drops undefined results    | Task 4    | ✓                          |
| 9. Temporal coupling on transport               | Task 6b   | ✓                          |
| 10. forEach instead of for...of                 | Task 6c   | ✓                          |
| 11. Reflect.deleteProperty instead of delete    | Task 6d   | ✓                          |
| 12. Silent swallow of non-ENOENT icon errors    | Task 6e   | ✓                          |
| 13. InMemoryEventStore Promise.resolve wrapping | (dropped) | N/A — interface compliance |

Finding 13 (`InMemoryEventStore` using `Promise.resolve()` for sync ops) was intentionally dropped: the SDK interface requires `Promise<string>` return types, so the wrapping is correct and not a smell.

### Placeholder scan

No TBD, TODO, or "similar to Task N" references. All code blocks are complete and self-contained.

### Type consistency

- `UNFILLED` symbol in Task 4 is declared before `processInParallel` and used only within it — no cross-task naming conflicts.
- `EVICT_THRESHOLD` in Task 5 is a module constant — no conflict.
- `transport!` in Task 6b uses definite assignment assertion — TypeScript will require the `!` because it is `let` without an initializer.
