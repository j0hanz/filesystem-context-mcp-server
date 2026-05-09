# Progress Session Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the entangled progress + task-status code in `src/tools/tool-execution.ts` into a deep `ProgressSession` (pure, in `src/lib/`) plus pluggable sinks (`McpProgressSink`, `TaskStoreSink` in `src/tools/progress-sinks.ts`), with consistent `step` / `set` / `status` / `complete` / `fail` semantics, deleting the legacy `withProgress` helper and the `reportTaskStatus` ALS along the way.

**Architecture:** A single `ProgressSession` class owns a monotonic cursor, a 50ms rate limit, and dispatches discriminated-union `ProgressEvent`s to a list of `ProgressSink`s. MCP-display quirks (100% normalization on terminal) live in the MCP sink, not the session. Public progress helpers (`runWithProgressSession`, `createBatchProgressCallbacks`, `completeProgressSession`, `resolveFinalProgressCurrent`) keep their import path via re-export from `tool-execution.ts`.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `module: NodeNext`), Node.js >= 24, `node:test` + `tsx/esm` for tests.

**Spec:** [docs/superpowers/specs/2026-05-09-progress-session-redesign-design.md](../specs/2026-05-09-progress-session-redesign-design.md)

---

## Conventions

- All relative imports in `.ts` files include `.js` extension (`module: NodeNext`).
- Type-only imports use `import type { X }` or inline `import { type X }`.
- Optional fields use the `...(value !== undefined ? { key: value } : {})` conditional-spread pattern, **never** assign `undefined`.
- All explicit return types required.
- Run after each task: `npm run type-check && npm run lint`. Run `npm run test` at major checkpoints.
- Commit after each task. Conventional commits (`feat:`, `refactor:`, `test:`, `chore:`).

---

## Task 1: Add `ProgressSession` skeleton with failing tests

**Files:**

- Create: `src/lib/progress-session.ts`
- Create: `__tests__/unit/progress-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/progress-session.test.ts`:

```ts
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  type ProgressEvent,
  ProgressSession,
  type ProgressSink,
} from '../../src/lib/progress-session.js';

class MemorySink implements ProgressSink {
  readonly name = 'memory';
  readonly events: ProgressEvent[] = [];
  emit(event: ProgressEvent): void {
    this.events.push(event);
  }
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

void describe('ProgressSession', () => {
  void it('emits a synthetic start tick on construction', () => {
    const sink = new MemorySink();
    new ProgressSession({
      label: 'Hash: foo.bin',
      total: 10,
      sinks: [sink],
      now: makeClock().now,
    });
    assert.equal(sink.events.length, 1);
    assert.deepEqual(sink.events[0], {
      kind: 'tick',
      current: 0,
      total: 10,
      message: 'Hash: foo.bin',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/progress-session.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/progress-session.ts`:

```ts
import { Logger } from './logger.js';

export type ProgressEvent =
  | { kind: 'tick'; current: number; total?: number; message: string }
  | { kind: 'status'; message: string }
  | { kind: 'complete'; current: number; total?: number; message: string }
  | {
      kind: 'fail';
      current: number;
      total?: number;
      message: string;
      error: unknown;
    };

export interface ProgressSink {
  readonly name: string;
  emit(event: ProgressEvent): Promise<void> | void;
}

export interface ProgressSessionOptions {
  label: string;
  total?: number;
  sinks: ProgressSink[];
  /** Clock injection for deterministic rate-limit tests. Defaults to Date.now. */
  now?: () => number;
  /** Override the rate limit window. Default: 50ms. */
  rateLimitMs?: number;
}

const DEFAULT_RATE_LIMIT_MS = 50;

export class ProgressSession {
  readonly #label: string;
  readonly #total: number | undefined;
  readonly #sinks: ProgressSink[];
  readonly #now: () => number;
  readonly #rateLimitMs: number;

  #cursor = 0;
  #lastSentMs = 0;
  #done = false;

  constructor(opts: ProgressSessionOptions) {
    this.#label = opts.label;
    this.#total = opts.total;
    this.#sinks = opts.sinks;
    this.#now = opts.now ?? Date.now;
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;

    // Synthetic start tick — preserves today's "fire 0/total at session creation" wire behavior.
    this.#dispatch({
      kind: 'tick',
      current: 0,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message: this.#label,
    });
  }

  get current(): number {
    return this.#cursor;
  }

  step(_message: string): void {
    // Implemented in Task 2.
  }

  set(_input: { current: number; total?: number; message?: string }): void {
    // Implemented in Task 2.
  }

  status(_message: string): void {
    // Implemented in Task 4.
  }

  complete(_message: string): void {
    // Implemented in Task 3.
  }

  fail(_error: unknown, _message?: string): void {
    // Implemented in Task 3.
  }

  #dispatch(event: ProgressEvent): void {
    // Rate limiting + monotonic guard added in later tasks; for now, always dispatch.
    for (const sink of this.#sinks) {
      this.#emitGuarded(sink, event);
    }
  }

  #emitGuarded(sink: ProgressSink, event: ProgressEvent): void {
    try {
      const result = sink.emit(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          Logger.warn('ProgressSink emit failed', {
            sink: sink.name,
            eventKind: event.kind,
            err,
          });
        });
      }
    } catch (err) {
      Logger.warn('ProgressSink emit failed', {
        sink: sink.name,
        eventKind: event.kind,
        err,
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: PASS — 1 test passing.

Run: `npm run type-check && npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress-session.ts __tests__/unit/progress-session.test.ts
git commit -m "feat(progress-session): scaffold ProgressSession with start-tick test"
```

---

## Task 2: `step` and `set` cursor mechanics

**Files:**

- Modify: `src/lib/progress-session.ts`
- Modify: `__tests__/unit/progress-session.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/unit/progress-session.test.ts` (inside the `describe('ProgressSession', ...)` block):

```ts
void it('step advances cursor by one and emits a tick', () => {
  const sink = new MemorySink();
  const clock = makeClock();
  const session = new ProgressSession({
    label: 'job',
    total: 3,
    sinks: [sink],
    now: clock.now,
  });
  sink.events.length = 0;

  clock.advance(100);
  session.step('one');
  clock.advance(100);
  session.step('two');

  assert.equal(session.current, 2);
  assert.equal(sink.events.length, 2);
  assert.deepEqual(sink.events[0], {
    kind: 'tick',
    current: 1,
    total: 3,
    message: 'one',
  });
  assert.deepEqual(sink.events[1], {
    kind: 'tick',
    current: 2,
    total: 3,
    message: 'two',
  });
});

void it('set clamps cursor monotonically and emits with provided fields', () => {
  const sink = new MemorySink();
  const clock = makeClock();
  const session = new ProgressSession({
    label: 'job',
    sinks: [sink],
    now: clock.now,
  });
  sink.events.length = 0;

  clock.advance(100);
  session.set({ current: 5, total: 10, message: 'five' });
  clock.advance(100);
  // Regress attempt: should clamp to existing cursor (5).
  session.set({ current: 2, message: 'should clamp' });

  assert.equal(session.current, 5);
  assert.equal(sink.events.length, 2);
  assert.deepEqual(sink.events[0], {
    kind: 'tick',
    current: 5,
    total: 10,
    message: 'five',
  });
  assert.deepEqual(sink.events[1], {
    kind: 'tick',
    current: 5,
    message: 'should clamp',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: FAIL — `step` and `set` are no-ops; events array length and cursor are 0.

- [ ] **Step 3: Implement `step` and `set`**

In `src/lib/progress-session.ts`, replace the `step` and `set` stub methods:

```ts
  step(message: string): void {
    if (this.#done) return;
    this.#cursor += 1;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message,
    });
  }

  set(input: { current: number; total?: number; message?: string }): void {
    if (this.#done) return;
    if (input.current > this.#cursor) {
      this.#cursor = input.current;
    }
    const total = input.total ?? this.#total;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(total !== undefined ? { total } : {}),
      message: input.message ?? this.#label,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: PASS — 3 tests passing.

Run: `npm run type-check && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress-session.ts __tests__/unit/progress-session.test.ts
git commit -m "feat(progress-session): implement step and set cursor mechanics"
```

---

## Task 3: `complete` and `fail` terminal events

**Files:**

- Modify: `src/lib/progress-session.ts`
- Modify: `__tests__/unit/progress-session.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the describe block:

```ts
void it('complete emits a complete event carrying the current cursor', () => {
  const sink = new MemorySink();
  const session = new ProgressSession({
    label: 'job',
    total: 5,
    sinks: [sink],
    now: makeClock().now,
  });
  session.step('a');
  session.step('b');
  sink.events.length = 0;

  session.complete('done');

  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0], {
    kind: 'complete',
    current: 2,
    total: 5,
    message: 'done',
  });
});

void it('fail emits a fail event with error and optional message', () => {
  const sink = new MemorySink();
  const session = new ProgressSession({
    label: 'job',
    sinks: [sink],
    now: makeClock().now,
  });
  sink.events.length = 0;
  const err = new Error('boom');

  session.fail(err, 'aborted');

  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0], {
    kind: 'fail',
    current: 0,
    message: 'aborted',
    error: err,
  });
});

void it('calls after a terminal event are no-ops', () => {
  const sink = new MemorySink();
  const session = new ProgressSession({
    label: 'job',
    sinks: [sink],
    now: makeClock().now,
  });
  session.complete('done');
  sink.events.length = 0;

  session.step('ignored');
  session.set({ current: 99, message: 'ignored' });
  session.complete('again');
  session.fail(new Error('again'));

  assert.equal(sink.events.length, 0);
  assert.equal(session.current, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: FAIL — `complete` and `fail` are stubs.

- [ ] **Step 3: Implement `complete` and `fail`**

In `src/lib/progress-session.ts`, replace the stubs:

```ts
  complete(message: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'complete',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message,
    });
  }

  fail(error: unknown, message?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'fail',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message: message ?? this.#label,
      error,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress-session.ts __tests__/unit/progress-session.test.ts
git commit -m "feat(progress-session): implement terminal complete and fail events"
```

---

## Task 4: `status` events (no cursor advance, no rate limit)

**Files:**

- Modify: `src/lib/progress-session.ts`
- Modify: `__tests__/unit/progress-session.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
void it('status emits a status event without advancing cursor', () => {
  const sink = new MemorySink();
  const session = new ProgressSession({
    label: 'job',
    total: 10,
    sinks: [sink],
    now: makeClock().now,
  });
  session.step('a');
  sink.events.length = 0;

  session.status('still scanning');

  assert.equal(session.current, 1);
  assert.equal(sink.events.length, 1);
  assert.deepEqual(sink.events[0], {
    kind: 'status',
    message: 'still scanning',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `status` is a stub.

- [ ] **Step 3: Implement `status`**

Replace the `status` stub:

```ts
  status(message: string): void {
    if (this.#done) return;
    this.#dispatch({ kind: 'status', message });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress-session.ts __tests__/unit/progress-session.test.ts
git commit -m "feat(progress-session): implement status events"
```

---

## Task 5: Rate limiting and monotonic guard for tick events

**Files:**

- Modify: `src/lib/progress-session.ts`
- Modify: `__tests__/unit/progress-session.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
void it('rate-limits tick events within 50ms window', () => {
  const sink = new MemorySink();
  const clock = makeClock();
  const session = new ProgressSession({
    label: 'job',
    sinks: [sink],
    now: clock.now,
  });
  sink.events.length = 0;

  clock.advance(100);
  session.step('a'); // emitted

  clock.advance(10);
  session.step('b'); // suppressed (within 50ms)

  clock.advance(10);
  session.step('c'); // suppressed

  clock.advance(50);
  session.step('d'); // emitted (60ms since last sent)

  assert.equal(sink.events.length, 2);
  assert.equal(sink.events[0]?.kind === 'tick' && sink.events[0].message, 'a');
  assert.equal(sink.events[1]?.kind === 'tick' && sink.events[1].message, 'd');
  // Cursor still advanced even when ticks were suppressed.
  assert.equal(session.current, 4);
});

void it('terminal events bypass the rate limit', () => {
  const sink = new MemorySink();
  const clock = makeClock();
  const session = new ProgressSession({
    label: 'job',
    sinks: [sink],
    now: clock.now,
  });
  sink.events.length = 0;

  clock.advance(100);
  session.step('a'); // emitted, marks lastSentMs

  clock.advance(5);
  session.complete('done'); // must emit despite being within 50ms

  assert.equal(sink.events.length, 2);
  assert.equal(sink.events[1]?.kind, 'complete');
});

void it('status events bypass the rate limit', () => {
  const sink = new MemorySink();
  const clock = makeClock();
  const session = new ProgressSession({
    label: 'job',
    sinks: [sink],
    now: clock.now,
  });
  sink.events.length = 0;

  clock.advance(100);
  session.step('a'); // emitted

  clock.advance(5);
  session.status('s1'); // emitted (status not rate-limited)
  clock.advance(5);
  session.status('s2'); // emitted

  assert.equal(sink.events.length, 3);
  assert.equal(sink.events[1]?.kind, 'status');
  assert.equal(sink.events[2]?.kind, 'status');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — rate limit not implemented yet; rate-limit test sees 4 events instead of 2.

- [ ] **Step 3: Implement rate limiting**

In `src/lib/progress-session.ts`, replace the `#dispatch` method:

```ts
  #dispatch(event: ProgressEvent): void {
    if (this.#shouldRateLimit(event)) return;
    if (event.kind === 'tick' || event.kind === 'complete' || event.kind === 'fail') {
      this.#lastSentMs = this.#now();
    }
    for (const sink of this.#sinks) {
      this.#emitGuarded(sink, event);
    }
  }

  #shouldRateLimit(event: ProgressEvent): boolean {
    if (event.kind !== 'tick') return false; // status/complete/fail bypass
    const elapsed = this.#now() - this.#lastSentMs;
    return elapsed < this.#rateLimitMs;
  }
```

Note: The synthetic start tick from the constructor will set `#lastSentMs` on first dispatch, so subsequent ticks within 50ms of construction are suppressed. This matches today's behavior (the legacy `createProgressReporter` initialized `lastSentMs = 0`, allowing the first real tick through; but the constructor's start tick now occupies that slot, so the first user-driven `step` may be suppressed if called immediately. The test above advances the clock by 100ms after construction to make this explicit.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: PASS — 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/progress-session.ts __tests__/unit/progress-session.test.ts
git commit -m "feat(progress-session): rate-limit tick events with terminal/status bypass"
```

---

## Task 6: Sink error guarding

**Files:**

- Modify: `__tests__/unit/progress-session.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
void it('sync sink errors are caught and other sinks still receive the event', () => {
  const goodSink = new MemorySink();
  const badSink: ProgressSink = {
    name: 'bad',
    emit() {
      throw new Error('sink failure');
    },
  };
  const session = new ProgressSession({
    label: 'job',
    sinks: [badSink, goodSink],
    now: makeClock().now,
  });
  // Constructor's start tick: badSink throws but session must construct.
  assert.equal(goodSink.events.length, 1);

  // Subsequent operations also unaffected.
  session.complete('done');
  assert.equal(goodSink.events.length, 2);
});

void it('async sink rejections are caught', async () => {
  const goodSink = new MemorySink();
  const badSink: ProgressSink = {
    name: 'bad-async',
    emit() {
      return Promise.reject(new Error('async sink failure'));
    },
  };
  const session = new ProgressSession({
    label: 'job',
    sinks: [badSink, goodSink],
    now: makeClock().now,
  });
  session.complete('done');

  // Allow microtask queue to drain so the rejection is observed-and-swallowed.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(goodSink.events.length, 2);
});

void it('empty sink array works without errors', () => {
  const session = new ProgressSession({
    label: 'job',
    total: 5,
    sinks: [],
    now: makeClock().now,
  });
  session.step('a');
  session.set({ current: 3, message: 'three' });
  session.status('s');
  session.complete('done');
  assert.equal(session.current, 3);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/progress-session.test.ts`
Expected: PASS — 13 tests passing. (Sink guarding was implemented in Task 1, so these tests confirm the implementation is correct.)

If they fail, audit `#emitGuarded` against the spec.

Run: `npm run type-check && npm run lint`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add __tests__/unit/progress-session.test.ts
git commit -m "test(progress-session): cover sync/async sink error guarding"
```

---

## Task 7: `McpProgressSink` with TDD

**Files:**

- Create: `src/tools/progress-sinks.ts`
- Create: `__tests__/tools/progress-sinks.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/tools/progress-sinks.test.ts`:

```ts
import type { ProgressNotification } from '@modelcontextprotocol/server';

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { McpProgressSink } from '../../src/tools/progress-sinks.js';

void describe('McpProgressSink', () => {
  void it('forwards tick events to sendNotification', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n as ProgressNotification);
      },
    });

    await sink.emit({
      kind: 'tick',
      current: 3,
      total: 10,
      message: 'three',
    });

    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], {
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        progress: 3,
        total: 10,
        message: 'three',
      },
    });
  });

  void it('ignores status events', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n as ProgressNotification);
      },
    });

    await sink.emit({ kind: 'status', message: 'scanning' });

    assert.equal(notifications.length, 0);
  });

  void it('normalizes complete events to 100% display', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n as ProgressNotification);
      },
    });

    // current=2, total=5 → display as 5/5 (legacy "show 100%" quirk).
    await sink.emit({
      kind: 'complete',
      current: 2,
      total: 5,
      message: 'done',
    });

    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0]?.params, {
      progressToken: 'tok-1',
      progress: 5,
      total: 5,
      message: 'done',
    });
  });

  void it('normalizes fail events to display max(current, total, 1)', async () => {
    const notifications: ProgressNotification[] = [];
    const sink = new McpProgressSink({
      progressToken: 'tok-1',
      sendNotification: async (n) => {
        notifications.push(n as ProgressNotification);
      },
    });

    // No total, current=0 → display 1/1.
    await sink.emit({
      kind: 'fail',
      current: 0,
      message: 'aborted',
      error: new Error('x'),
    });

    assert.deepEqual(notifications[0]?.params, {
      progressToken: 'tok-1',
      progress: 1,
      total: 1,
      message: 'aborted',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/tools/progress-sinks.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/progress-sinks.js'`.

- [ ] **Step 3: Create `progress-sinks.ts` with `McpProgressSink`**

Create `src/tools/progress-sinks.ts`:

```ts
import type {
  ProgressNotification,
  ProgressToken,
} from '@modelcontextprotocol/server';

import type { ProgressEvent, ProgressSink } from '../lib/progress-session.js';

interface McpProgressSinkOptions {
  progressToken: ProgressToken;
  sendNotification: (n: ProgressNotification) => Promise<void>;
}

export class McpProgressSink implements ProgressSink {
  readonly name = 'mcp';
  readonly #progressToken: ProgressToken;
  readonly #sendNotification: (n: ProgressNotification) => Promise<void>;

  constructor(opts: McpProgressSinkOptions) {
    this.#progressToken = opts.progressToken;
    this.#sendNotification = opts.sendNotification;
  }

  async emit(event: ProgressEvent): Promise<void> {
    if (event.kind === 'status') return;

    if (event.kind === 'tick') {
      await this.#send({
        progress: event.current,
        ...(event.total !== undefined ? { total: event.total } : {}),
        message: event.message,
      });
      return;
    }

    // complete | fail — normalize to 100% display.
    const displayCurrent = Math.max(
      event.current,
      event.total ?? event.current,
      1
    );
    await this.#send({
      progress: displayCurrent,
      total: displayCurrent,
      message: event.message,
    });
  }

  async #send(params: {
    progress: number;
    total?: number;
    message?: string;
  }): Promise<void> {
    await this.#sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken: this.#progressToken,
        ...params,
      },
    } satisfies ProgressNotification);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/tools/progress-sinks.test.ts`
Expected: PASS — 4 tests passing.

Run: `npm run type-check && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/progress-sinks.ts __tests__/tools/progress-sinks.test.ts
git commit -m "feat(progress-sinks): McpProgressSink with 100%-display normalization"
```

---

## Task 8: `TaskStoreSink` with TDD

**Files:**

- Modify: `src/tools/progress-sinks.ts`
- Modify: `__tests__/tools/progress-sinks.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/tools/progress-sinks.test.ts`:

```ts
import { TaskStoreSink } from '../../src/tools/progress-sinks.js';

interface FakeUpdateCall {
  taskId: string;
  status: string;
  message: string;
}

class FakeTaskStore {
  readonly calls: FakeUpdateCall[] = [];
  shouldReject?: Error;
  async updateTaskStatus(
    taskId: string,
    status: 'working' | 'completed' | 'failed',
    message: string
  ): Promise<void> {
    if (this.shouldReject) throw this.shouldReject;
    this.calls.push({ taskId, status, message });
  }
}

void describe('TaskStoreSink', () => {
  void it('writes "working" status for tick events with current/total formatting', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    await sink.emit({
      kind: 'tick',
      current: 3,
      total: 10,
      message: 'scanning',
    });

    assert.equal(store.calls.length, 1);
    assert.deepEqual(store.calls[0], {
      taskId: 't-1',
      status: 'working',
      message: 'scanning (3/10)',
    });
  });

  void it('uses raw message for status events', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    await sink.emit({ kind: 'status', message: 'still scanning subtree X' });

    assert.deepEqual(store.calls[0]?.message, 'still scanning subtree X');
  });

  void it('writes complete and fail events as working updates', async () => {
    const store = new FakeTaskStore();
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    await sink.emit({
      kind: 'complete',
      current: 5,
      total: 5,
      message: 'all done',
    });
    await sink.emit({
      kind: 'fail',
      current: 2,
      total: 5,
      message: 'aborted',
      error: new Error('x'),
    });

    assert.equal(store.calls.length, 2);
    assert.equal(store.calls[0]?.status, 'working');
    assert.equal(store.calls[0]?.message, 'all done (5/5)');
    assert.equal(store.calls[1]?.message, 'aborted (2/5)');
  });

  void it('swallows benign "Task not found" errors', async () => {
    const store = new FakeTaskStore();
    store.shouldReject = new Error('Task t-1 not found');
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    // Must not throw.
    await sink.emit({
      kind: 'tick',
      current: 1,
      total: 1,
      message: 'm',
    });
  });

  void it('swallows benign "terminal status" errors', async () => {
    const store = new FakeTaskStore();
    store.shouldReject = new Error('Cannot update terminal status');
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    await sink.emit({
      kind: 'tick',
      current: 1,
      total: 1,
      message: 'm',
    });
  });

  void it('rethrows non-benign errors so emitGuarded can log them', async () => {
    const store = new FakeTaskStore();
    store.shouldReject = new Error('database offline');
    const sink = new TaskStoreSink({ taskStore: store, taskId: 't-1' });

    await assert.rejects(
      () =>
        Promise.resolve(
          sink.emit({
            kind: 'tick',
            current: 1,
            total: 1,
            message: 'm',
          })
        ),
      /database offline/
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/tools/progress-sinks.test.ts`
Expected: FAIL — `TaskStoreSink` not exported.

- [ ] **Step 3: Implement `TaskStoreSink`**

In `src/tools/progress-sinks.ts`, append:

```ts
import type { RequestTaskStore } from '@modelcontextprotocol/server';

interface TaskStoreSinkOptions {
  taskStore: RequestTaskStore;
  taskId: string;
}

const BENIGN_TASK_ERROR_RE = /Task .*not found|terminal status/iu;

function isBenignTaskStoreError(error: unknown): boolean {
  return error instanceof Error && BENIGN_TASK_ERROR_RE.test(error.message);
}

function formatTickMessage(
  current: number,
  total: number | undefined,
  message: string | undefined
): string {
  if (total !== undefined) {
    return message ? `${message} (${current}/${total})` : `${current}/${total}`;
  }
  return message ?? `${current}`;
}

export class TaskStoreSink implements ProgressSink {
  readonly name = 'task-store';
  readonly #taskStore: RequestTaskStore;
  readonly #taskId: string;

  constructor(opts: TaskStoreSinkOptions) {
    this.#taskStore = opts.taskStore;
    this.#taskId = opts.taskId;
  }

  async emit(event: ProgressEvent): Promise<void> {
    const message =
      event.kind === 'status'
        ? event.message
        : formatTickMessage(event.current, event.total, event.message);

    try {
      await this.#taskStore.updateTaskStatus(this.#taskId, 'working', message);
    } catch (error) {
      if (isBenignTaskStoreError(error)) return;
      throw error;
    }
  }
}
```

Add the new import at the top of the file (merge with existing import block):

```ts
import type {
  ProgressNotification,
  ProgressToken,
  RequestTaskStore,
} from '@modelcontextprotocol/server';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/tools/progress-sinks.test.ts`
Expected: PASS — 10 tests passing total.

Run: `npm run type-check && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/progress-sinks.ts __tests__/tools/progress-sinks.test.ts
git commit -m "feat(progress-sinks): TaskStoreSink with benign-error swallowing"
```

---

## Task 9: `progressSessionFromContext` bridge

**Files:**

- Modify: `src/tools/progress-sinks.ts`
- Modify: `__tests__/tools/progress-sinks.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
import { progressSessionFromContext } from '../../src/tools/progress-sinks.js';
import type { ToolContext } from '../../src/tools/shared.js';

void describe('progressSessionFromContext', () => {
  void it('returns a session with no sinks when no progress context is available', () => {
    const ctx = {
      signal: new AbortController().signal,
    } as unknown as ToolContext;
    const session = progressSessionFromContext(ctx, { label: 'job' });
    // Session must construct without errors and accept calls.
    session.step('a');
    session.complete('done');
    assert.equal(session.current, 1);
  });

  void it('attaches McpProgressSink when progressToken+sendNotification are present', async () => {
    const notifications: ProgressNotification[] = [];
    const ctx = {
      signal: new AbortController().signal,
      _meta: { progressToken: 'tok-1' },
      sendNotification: async (n: ProgressNotification) => {
        notifications.push(n);
      },
    } as unknown as ToolContext;

    const session = progressSessionFromContext(ctx, {
      label: 'job',
      total: 5,
    });
    // Construction emits start tick.
    await new Promise((r) => setImmediate(r));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.params.progress, 0);
  });

  void it('attaches TaskStoreSink when task fields are present', async () => {
    const store = new FakeTaskStore();
    const ctx = {
      signal: new AbortController().signal,
      taskId: 't-1',
      taskStore: store,
    } as unknown as ToolContext;

    progressSessionFromContext(ctx, { label: 'job' });
    await new Promise((r) => setImmediate(r));
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0]?.taskId, 't-1');
  });

  void it('attaches both sinks when both progress sources are present', async () => {
    const notifications: ProgressNotification[] = [];
    const store = new FakeTaskStore();
    const ctx = {
      signal: new AbortController().signal,
      _meta: { progressToken: 'tok-1' },
      sendNotification: async (n: ProgressNotification) => {
        notifications.push(n);
      },
      taskId: 't-1',
      taskStore: store,
    } as unknown as ToolContext;

    progressSessionFromContext(ctx, { label: 'job', total: 3 });
    await new Promise((r) => setImmediate(r));
    assert.equal(notifications.length, 1);
    assert.equal(store.calls.length, 1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — `progressSessionFromContext` not exported.

- [ ] **Step 3: Implement the bridge**

In `src/tools/progress-sinks.ts`, append:

```ts
import { Logger } from '../lib/logger.js';
import { ProgressSession } from '../lib/progress-session.js';

import type { TaskToolContext, ToolContext } from './shared.js';

function hasMcpProgress(ctx: ToolContext): ctx is ToolContext & {
  _meta: { progressToken: ProgressToken };
  sendNotification: NonNullable<ToolContext['sendNotification']>;
} {
  return (
    ctx._meta?.progressToken !== undefined && ctx.sendNotification !== undefined
  );
}

function hasTaskProgress(ctx: ToolContext): ctx is TaskToolContext & {
  taskId: string;
  taskStore: RequestTaskStore;
} {
  const candidate = ctx as TaskToolContext;
  return (
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0 &&
    candidate.taskStore !== undefined
  );
}

interface BridgeOptions {
  label: string;
  total?: number;
}

export function progressSessionFromContext(
  ctx: ToolContext,
  opts: BridgeOptions
): ProgressSession {
  const sinks: ProgressSink[] = [];

  if (hasMcpProgress(ctx)) {
    try {
      sinks.push(
        new McpProgressSink({
          progressToken: ctx._meta.progressToken,
          sendNotification: ctx.sendNotification,
        })
      );
    } catch (err) {
      Logger.warn('Failed to construct McpProgressSink', { err });
    }
  }

  if (hasTaskProgress(ctx)) {
    try {
      sinks.push(
        new TaskStoreSink({
          taskStore: ctx.taskStore,
          taskId: ctx.taskId,
        })
      );
    } catch (err) {
      Logger.warn('Failed to construct TaskStoreSink', { err });
    }
  }

  return new ProgressSession({
    label: opts.label,
    ...(opts.total !== undefined ? { total: opts.total } : {}),
    sinks,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/tools/progress-sinks.test.ts`
Expected: PASS — 14 tests passing.

Run: `npm run type-check && npm run lint`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/progress-sinks.ts __tests__/tools/progress-sinks.test.ts
git commit -m "feat(progress-sinks): progressSessionFromContext bridge"
```

---

## Task 10: New `runWithProgressSession` / `createBatchProgressCallbacks` / `completeProgressSession` / `resolveFinalProgressCurrent` in `progress-sinks.ts`

**Files:**

- Modify: `src/tools/progress-sinks.ts`

- [ ] **Step 1: Add the public helpers**

Append to `src/tools/progress-sinks.ts`:

```ts
import { classifyError } from '../lib/errors.js';

/** Final-cursor heuristic preserved from legacy implementation. */
export function resolveFinalProgressCurrent(
  progress: ProgressSession,
  ...candidates: number[]
): number {
  let finalCurrent = progress.current + 1;
  for (const candidate of candidates) {
    if (candidate > finalCurrent) finalCurrent = candidate;
  }
  return finalCurrent;
}

interface BatchProgressCallbacks {
  progress: ProgressSession;
  onItemComplete: () => void;
}

interface BatchParams {
  toolLabel: string;
  context: string;
  totalItems: number;
  itemVerb: string;
}

export function createBatchProgressCallbacks(
  ctx: ToolContext,
  params: BatchParams
): BatchProgressCallbacks {
  const progress = progressSessionFromContext(ctx, {
    label: `${params.toolLabel}: ${params.context}`,
    total: params.totalItems,
  });

  let itemsDone = 0;
  const onItemComplete = (): void => {
    itemsDone++;
    progress.set({
      current: itemsDone,
      total: params.totalItems,
      message: `${params.toolLabel}: ${params.context} [${itemsDone}/${params.totalItems} ${params.itemVerb}]`,
    });
  };

  return { progress, onItemComplete };
}

export async function completeProgressSession<T>(
  progress: ProgressSession,
  label: string,
  body: () => Promise<{ value: T; suffix: string; finalCurrent?: number }>
): Promise<T> {
  try {
    const { value, suffix } = await body();
    progress.complete(`${label} • ${suffix}`);
    return value;
  } catch (error) {
    progress.fail(error, `${label} • ${classifyError(error)}`);
    throw error;
  }
}

export async function runWithProgressSession<T>(
  ctx: ToolContext,
  label: string,
  body: (
    progress: ProgressSession
  ) => Promise<{ value: T; suffix: string; finalCurrent?: number }>,
  initialTotal?: number
): Promise<T> {
  const progress = progressSessionFromContext(ctx, {
    label,
    ...(initialTotal !== undefined ? { total: initialTotal } : {}),
  });
  return completeProgressSession(progress, label, () => body(progress));
}
```

Note: `finalCurrent` is no longer threaded into `complete` (the MCP sink owns 100% normalization now). It's accepted in the body return shape for backward compatibility with existing call sites that pass it; it's just ignored by the new implementation.

Re-export `ProgressSession` from this file for ergonomic imports:

```ts
export { ProgressSession } from '../lib/progress-session.js';
export type { ProgressEvent, ProgressSink } from '../lib/progress-session.js';
```

- [ ] **Step 2: Type-check**

Run: `npm run type-check && npm run lint`
Expected: 0 errors. The new `progress-sinks.ts` is now self-contained.

- [ ] **Step 3: Commit**

```bash
git add src/tools/progress-sinks.ts
git commit -m "feat(progress-sinks): public helpers (run/createBatch/complete/resolveFinal)"
```

---

## Task 11: Migrate `tree.ts` and `search-files.ts` and `replace-in-files.ts` and `calculate-hash.ts`

**Files:**

- Modify: `src/tools/tree.ts:611-625` (the `progress.update` call inside `runWithProgressSession`)
- Modify: `src/tools/search-files.ts:754-768`
- Modify: `src/tools/replace-in-files.ts:751-770`
- Modify: `src/tools/calculate-hash.ts:325-345`

These four tools all do the same thing: call `progress.update({ current, total?, message })`. The new method name is `progress.set({ ... })` with identical semantics.

- [ ] **Step 1: Rename `progress.update(` → `progress.set(` in all four files**

For each of the four files, replace exactly one call site:

**`src/tools/tree.ts` around line 616:**
Change `progress.update({` to `progress.set({`. The body is unchanged.

**`src/tools/search-files.ts` around line 762:**
Change `progress.update({` to `progress.set({`.

**`src/tools/replace-in-files.ts` around line 759:**
Change `progress.update({` to `progress.set({`.

**`src/tools/calculate-hash.ts` around line 335:**
Change `progress.update({` to `progress.set({`.

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: errors complaining `update` is not a method on `ProgressSession` — but only at call sites in `tool-execution.ts` (which still imports the old `ToolProgressSession`). The 4 migrated tools should type-check against the new `ProgressSession` once Task 12 lands.

For now expect: a type-check that surfaces the boundary cleanly. Document errors in a scratch file if needed.

Note: this task may not type-check standalone — it depends on Task 12 to swap the `ProgressSession` type into the call sites. **Skip type-check verification for this task; just do the renames and commit.**

- [ ] **Step 3: Commit**

```bash
git add src/tools/tree.ts src/tools/search-files.ts src/tools/replace-in-files.ts src/tools/calculate-hash.ts
git commit -m "refactor(tools): rename progress.update -> progress.set in 4 tools"
```

---

## Task 12: Migrate `read-multiple.ts` and `search-content.ts` (drop `reportTaskStatus`)

**Files:**

- Modify: `src/tools/read-multiple.ts:840-880`
- Modify: `src/tools/search-content.ts:1885-1915`

These tools use the deleted `reportTaskStatus(...)` to push status-only messages. Replace with `progress.status(...)`.

- [ ] **Step 1: Edit `read-multiple.ts`**

Change the import block (around line 49-51) to remove `reportTaskStatus`:

```ts
// Before:
//   completeProgressSession,
//   createBatchProgressCallbacks,
//   reportTaskStatus,
//   resolveFinalProgressCurrent,
// After:
//   completeProgressSession,
//   createBatchProgressCallbacks,
//   resolveFinalProgressCurrent,
```

Replace lines around 856-859:

```ts
// Before:
//     const onItemComplete = (): void => {
//       rawOnItemComplete();
//       itemsDone++;
//       void reportTaskStatus(
//         `${label} [${itemsDone}/${args.paths.length} read]`
//       );
//     };
// After:
const onItemComplete = (): void => {
  rawOnItemComplete();
  itemsDone++;
  progress.status(`${label} [${itemsDone}/${args.paths.length} read]`);
};
```

- [ ] **Step 2: Edit `search-content.ts`**

Remove `reportTaskStatus` from the import at line 78. In the `progressWithMessage` callback around line 1895-1901, replace:

```ts
// Before:
//       const progressWithMessage = ({ current, total }: ...) => {
//         progress.update({
//           current,
//           ...(total !== undefined ? { total } : {}),
//           message: `${progressLabel} [${current} files]`,
//         });
//         void reportTaskStatus(`${progressLabel} ${current} files`);
//       };
// After:
const progressWithMessage = ({
  current,
  total,
}: {
  total?: number;
  current: number;
}): void => {
  progress.set({
    current,
    ...(total !== undefined ? { total } : {}),
    message: `${progressLabel} [${current} files]`,
  });
  progress.status(`${progressLabel} ${current} files`);
};
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/read-multiple.ts src/tools/search-content.ts
git commit -m "refactor(tools): replace reportTaskStatus with progress.status"
```

---

## Task 13: Rewire `tool-execution.ts` and delete legacy code

**Files:**

- Modify: `src/tools/tool-execution.ts`

This is the biggest single edit. It deletes ~250 lines of legacy code and replaces them with re-exports plus the rewired `wrapToolHandler`.

- [ ] **Step 1: Delete legacy progress code**

In `src/tools/tool-execution.ts`, delete the following sections:

- The `=== Section C: Progress Infrastructure ===` block from `const PROGRESS_RATE_LIMIT_MS = 50;` down through and including the entire `runWithProgressSession` definition (lines 96 ~ 366 in the current file).
- The `withProgress` function (lines ~368-400).
- The `canSendProgress` and `canReportProgress` helpers — they are now internal to `progress-sinks.ts` (move them there if needed; otherwise keep `canReportProgress` if `wrapToolHandler` still needs it for the `progressMessage` short-circuit).
- The `taskContext` `AsyncLocalStorage` and the entire `reportTaskStatus` function (around lines 482-505).

Keep:

- `formatTaskStatusMessage` if used elsewhere, otherwise delete.
- `isBenignTaskStatusUpdateError` if used elsewhere, otherwise delete (it now lives in `progress-sinks.ts`).
- The `isTaskToolContext` type guard — it's used by `wrapToolHandler` and for task-mode dispatch; **keep it** in `tool-execution.ts`.
- Everything from `interface TaskDiagnosticsEvent` onward (task lifecycle, `registerStandardTool`, etc.) — **untouched by this refactor**.

- [ ] **Step 2: Rewire `wrapToolHandler` to use `progressSessionFromContext`**

Replace the body of `wrapToolHandler` to call into the session API:

```ts
function wrapToolHandler<Args, Result>(
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: {
    guard?: (() => boolean) | undefined;
    progressMessage?: (args: Args) => string;
    completionMessage?: (
      args: Args,
      result: ToolResult<Result>
    ) => string | undefined;
  }
): (
  args: Args,
  ctx?: ToolContext | ServerContext
) => Promise<ToolResult<Result>> {
  return async (args: Args, ctx?: ToolContext | ServerContext) => {
    const resolvedExtra = toToolContext(ctx);
    if (options.guard && !options.guard()) {
      return maybeStripStructuredContentFromResult(buildNotInitializedResult());
    }

    if (!options.progressMessage) {
      const result = await handler(args, resolvedExtra);
      return maybeStripStructuredContentFromResult(result);
    }

    const message = options.progressMessage(args);
    const session = progressSessionFromContext(resolvedExtra, {
      label: message,
      total: 1,
    });

    try {
      const result = await handler(args, resolvedExtra);
      const endMessage = options.completionMessage?.(args, result) ?? message;
      session.complete(endMessage);
      return maybeStripStructuredContentFromResult(result);
    } catch (error) {
      session.fail(error, `${message} • ${classifyError(error)}`);
      throw error;
    }
  };
}
```

Add the import at the top of `tool-execution.ts`:

```ts
import { progressSessionFromContext } from './progress-sinks.js';
```

- [ ] **Step 3: Re-export public helpers for path stability**

Add at the bottom of `tool-execution.ts`:

```ts
export {
  ProgressSession,
  createBatchProgressCallbacks,
  completeProgressSession,
  resolveFinalProgressCurrent,
  runWithProgressSession,
} from './progress-sinks.js';
export type { ProgressEvent, ProgressSink } from './progress-sinks.js';
```

Delete the existing local exports of these symbols (since they're now re-exports).

Also delete the `toolContextToOnProgress` export — it's no longer needed.

- [ ] **Step 4: Update other call sites that imported `toolContextToOnProgress`**

Search for `toolContextToOnProgress` across the repo:

Run: `grep -r "toolContextToOnProgress" src/ __tests__/`

For each match outside `tool-execution.ts`: if it's used to convert a `ToolContext` into a `HandlerContext.onProgress` callback, replace with a call to `progressSessionFromContext(ctx, { label }).set(...)` or thread the session through directly. Most likely it's only called from `define-tool.ts` (HandlerContext bridge) — read that call site and adapt.

- [ ] **Step 5: Run full type-check, lint, and tests**

Run: `npm run type-check`
Expected: 0 errors. If errors persist, audit the affected file and fix imports.

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

Run: `npm run test`
Expected: all tests pass. Pay special attention to:

- `__tests__/unit/progress-session.test.ts` — passes (new).
- `__tests__/tools/progress-sinks.test.ts` — passes (new).
- `__tests__/tools/task-mode.test.ts` — passes (preserved, observable behavior unchanged).
- `__tests__/tools/worker-offload.test.ts` — passes.
- `__tests__/tools/read-write.test.ts` — passes.
- `__tests__/tools/search.test.ts` — passes (covers tree, search-files, search-content).

If `task-mode.test.ts` fails on terminal-progress assertions, audit `McpProgressSink`'s 100% normalization against the test's expected wire shape. The test was passing against the legacy `complete(message, minimumCurrent)` path with `finalCurrent` from `resolveFinalProgressCurrent`; the new implementation reaches the same display via `Math.max(current, total ?? current, 1)`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(tool-execution): rewire wrapToolHandler onto ProgressSession; delete legacy progress + reportTaskStatus"
```

---

## Task 14: Run full task pipeline and audit

**Files:** none directly modified.

- [ ] **Step 1: Full task pipeline**

Run: `node scripts/tasks.mjs`
Expected: format → [lint, type-check, knip] → [test, rebuild] all green.

- [ ] **Step 2: Knip audit**

The deletions may have left orphan exports. If knip flags unused exports in `tool-execution.ts`, `progress-sinks.ts`, or related files, decide:

- If the symbol is **internal-only** now, drop the `export` keyword.
- If it's **public surface** intentionally re-exported, add to `knip.json` ignores or wire it into the export barrel.

- [ ] **Step 3: Manual audit of `tool-execution.ts` size**

Run: `wc -l src/tools/tool-execution.ts` (or PowerShell equivalent: `(Get-Content src/tools/tool-execution.ts | Measure-Object -Line).Lines`).
Expected: file shrinks from ~1209 lines to ~950 lines or fewer (250+ lines of progress code removed).

- [ ] **Step 4: Verify no remaining references to deleted symbols**

Run these greps; each should return zero results:

```bash
grep -r "reportTaskStatus" src/ __tests__/
grep -r "withProgress" src/ __tests__/   # only matches inside `runWithProgressSession` substring; check carefully
grep -r "buildProgressSessionFromOnProgress" src/ __tests__/
grep -r "toolContextToOnProgress" src/ __tests__/
grep -r "createProgressReporter" src/ __tests__/
grep -r "taskContext\.getStore" src/ __tests__/
grep -r "ToolProgressSession" src/ __tests__/
```

If any return matches, those references must be migrated or the search refined (`runWithProgressSession` will match on `withProgress` substring — check by hand).

- [ ] **Step 5: Final commit if knip / cleanup edits were needed**

```bash
git add -A
git status   # confirm what's changing
git commit -m "chore(progress-session): post-refactor cleanup (knip, exports)"
```

If nothing to commit, skip.

---

## Self-Review Checklist

Run through this after writing the plan; fix issues inline.

**1. Spec coverage:**

- §1 Architecture (3 files, 3 named pieces) → Tasks 1-10 + 13.
- §2 Components (`ProgressSession`, `ProgressEvent`, `ProgressSink`, `McpProgressSink`, `TaskStoreSink`, `progressSessionFromContext`, public helpers) → Tasks 1-10.
- §3 Data flow (start tick, step/set/status, terminal) → Tasks 1, 2, 3, 4, 5, covered by tests.
- §4 Error handling (sink throws, sink rejects, terminal idempotency, monotonic clamp) → Tasks 3, 5, 6.
- §5 Testing strategy → Tasks 1-9 each include the test file additions.
- §6 Migration & breaking changes → Tasks 11, 12, 13. Re-export of public helpers in Task 13 Step 3.

**2. Placeholder scan:** No `TBD`, no "implement later". Code blocks are present at every code step. Step 11 has a documented type-check skip with rationale.

**3. Type consistency:**

- `ProgressSession` constructor: `{ label, total?, sinks, now?, rateLimitMs? }` — consistent across Tasks 1, 2, 3, 4, 5, 6, 9, 10.
- `ProgressEvent` union — defined Task 1, used unchanged.
- `ProgressSink.emit(event)` returns `Promise<void> | void` — Tasks 1, 7, 8, 9.
- `progressSessionFromContext(ctx, { label, total? })` — defined Task 9, called Tasks 10, 13.
- Method names: `step`, `set`, `status`, `complete`, `fail` — consistent across Tasks 2-12.

**4. Migration completeness:** All call sites listed in spec §6 are addressed by Tasks 11 and 12. Public re-exports preserve import paths in Task 13 Step 3.
