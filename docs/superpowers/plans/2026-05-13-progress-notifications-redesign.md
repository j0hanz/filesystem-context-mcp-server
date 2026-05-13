# Progress & Notifications Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace clutter-doubled progress strings with a clean two-surface formatting system: plain-text MCP status notifications and ANSI-colored server stderr output.

**Architecture:** New `src/core/fmt.ts` owns `ProgressCtx`, `Phase`, `plainMessage()`, and `ansiLine()`. `ToolDef.progressLabel` is replaced by `progress` (returns `ProgressCtx`) and `progressDone` (merges result stats). `StderrProgressSink` wires `ProgressSession` to colored stderr. The orchestrator's double-prefix is removed in `tasks.ts`. `onProgress` drops its now-unused `message` field.

**Tech Stack:** TypeScript strict + ESM (`.js` import extensions), Zod v4, `node:test` with `tsx/esm` loader, raw ANSI escape codes (no new deps).

---

## File Map

| Action | Path                                       | Responsibility                                         |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| Create | `src/core/fmt.ts`                          | `ProgressCtx`, `Phase`, `plainMessage`, `ansiLine`     |
| Modify | `src/core/observability.ts`                | Add `StderrProgressSink`                               |
| Modify | `src/tools/_helpers.ts`                    | Drop `message?` from `ToolContext.onProgress`          |
| Modify | `src/tasks.ts`                             | Remove double-prefix; simplify `interceptedOnProgress` |
| Modify | `src/tools/define.ts`                      | `ToolDef` interface; wire fmt + sink in `coreHandler`  |
| Modify | `src/tools/search-content.ts`              | Remove inline `message` string from `onProgress` call  |
| Modify | `src/tools/replace-in-files.ts`            | Same as above                                          |
| Modify | `src/tools/read.ts`                        | `progressLabel` → `progress` + `progressDone`          |
| Modify | `src/tools/edit.ts`                        | Same pattern                                           |
| Modify | `src/tools/search-files.ts`                | Same pattern                                           |
| Modify | `src/tools/list.ts`                        | Same pattern                                           |
| Modify | `src/tools/create.ts`                      | Same pattern                                           |
| Modify | `src/tools/move.ts`                        | Same pattern                                           |
| Modify | `src/tools/delete-file.ts`                 | Same pattern                                           |
| Modify | `src/tools/calculate-hash.ts`              | Same pattern                                           |
| Modify | `src/tools/stat.ts`                        | Same pattern                                           |
| Create | `__tests__/unit/fmt.test.ts`               | Unit tests for `plainMessage` + `ansiLine`             |
| Modify | `__tests__/unit/task-orchestrator.test.ts` | Assert no double-prefix in statusMessage               |

---

## Task 1: Create `src/core/fmt.ts`

**Files:**

- Create: `src/core/fmt.ts`
- Create: `__tests__/unit/fmt.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/fmt.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ansiLine, plainMessage } from '../../src/core/fmt.js';
import type { Phase, ProgressCtx } from '../../src/core/fmt.js';

describe('plainMessage', () => {
  it('start: label only', () => {
    assert.equal(plainMessage('start', { label: 'Read' }), 'Read:');
  });

  it('start: label + subject', () => {
    assert.equal(plainMessage('start', { label: 'Read', subject: 'tasks.ts' }), 'Read: tasks.ts');
  });

  it('start: label + subject + scope', () => {
    assert.equal(
      plainMessage('start', { label: 'Search', subject: 'async.*await', scope: 'src/' }),
      'Search: async.*await  src/',
    );
  });

  it('tick: subject + current/total', () => {
    assert.equal(
      plainMessage('tick', { label: 'Search', subject: 'async.*await', current: 45, total: 500 }),
      'Search: async.*await  45/500',
    );
  });

  it('tick: current only (no total)', () => {
    assert.equal(
      plainMessage('tick', { label: 'Search', subject: 'async.*await', current: 45 }),
      'Search: async.*await  45',
    );
  });

  it('tick: no subject, no current — label only', () => {
    assert.equal(plainMessage('tick', { label: 'Hash' }), 'Hash:');
  });

  it('done: subject + scope + detail', () => {
    assert.equal(
      plainMessage('done', {
        label: 'Search',
        subject: 'async.*await',
        scope: 'src/',
        detail: '23 matches · 8 files',
      }),
      'Search: async.*await  src/  23 matches · 8 files',
    );
  });

  it('done: subject only (no scope, no detail)', () => {
    assert.equal(
      plainMessage('done', { label: 'Edit', subject: 'tasks.ts+2-2 · index.ts+50-25' }),
      'Edit: tasks.ts+2-2 · index.ts+50-25',
    );
  });

  it('done: scope omitted when undefined', () => {
    assert.equal(
      plainMessage('done', { label: 'Read', subject: 'tasks.ts', detail: '2.3 KB' }),
      'Read: tasks.ts  2.3 KB',
    );
  });

  it('fail: subject + error', () => {
    assert.equal(
      plainMessage('fail', {
        label: 'Edit',
        subject: 'tasks.ts',
        error: 'EACCES: permission denied',
      }),
      'Edit: tasks.ts  EACCES: permission denied',
    );
  });

  it('fail: no error — label + subject only', () => {
    assert.equal(plainMessage('fail', { label: 'Edit', subject: 'tasks.ts' }), 'Edit: tasks.ts');
  });
});

describe('ansiLine', () => {
  // Strip ANSI codes for readable assertions
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('start symbol is →', () => {
    assert.ok(strip(ansiLine('start', { label: 'Read', subject: 'tasks.ts' })).startsWith('→'));
  });

  it('tick symbol is ·', () => {
    assert.ok(strip(ansiLine('tick', { label: 'Read', current: 3, total: 10 })).startsWith('·'));
  });

  it('done symbol is ✓', () => {
    assert.ok(strip(ansiLine('done', { label: 'Read', subject: 'tasks.ts' })).startsWith('✓'));
  });

  it('fail symbol is ✗', () => {
    assert.ok(strip(ansiLine('fail', { label: 'Edit', error: 'EACCES' })).startsWith('✗'));
  });

  it('plain text is embedded in ansi output', () => {
    const plain = strip(ansiLine('done', { label: 'Read', subject: 'tasks.ts', detail: '2.3 KB' }));
    assert.ok(plain.includes('Read: tasks.ts  2.3 KB'));
  });

  it('+N and -N patterns are wrapped in ANSI codes', () => {
    const raw = ansiLine('done', { label: 'Edit', subject: 'tasks.ts+2-2' });
    // +2 should have green ANSI, -2 should have red ANSI
    assert.ok(raw.includes('\x1b[32m+2\x1b[0m'), 'expected green +2');
    assert.ok(raw.includes('\x1b[31m-2\x1b[0m'), 'expected red -2');
  });

  it('durationMs appended as dim text when provided', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'f.ts', durationMs: 89 });
    assert.ok(raw.includes('89ms'));
  });

  it('durationMs over 1000ms formatted as seconds', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'f.ts', durationMs: 2100 });
    assert.ok(raw.includes('2.1s'));
  });

  it('durationMs absent — no timing suffix', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'f.ts' });
    assert.ok(!raw.includes('ms') && !raw.includes('s  '));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test --import tsx/esm "__tests__/unit/fmt.test.ts"
```

Expected: all tests fail with `Cannot find module '../../src/core/fmt.js'`

- [ ] **Step 3: Create `src/core/fmt.ts`**

```typescript
// src/core/fmt.ts

const ESC = '\x1b[';
const R = `${ESC}0m`; // reset
const B = `${ESC}1m`; // bold
const DIM = `${ESC}2m`; // dim
const GRN = `${ESC}32m`; // green
const RED = `${ESC}31m`; // red
const CYN = `${ESC}36m`; // cyan
const GRY = `${ESC}90m`; // gray

export interface ProgressCtx {
  label: string;
  subject?: string;
  scope?: string;
  current?: number;
  total?: number;
  detail?: string;
  error?: string;
  durationMs?: number;
}

export type Phase = 'start' | 'tick' | 'done' | 'fail';

function buildBody(ctx: ProgressCtx, phase: Phase): string {
  const items: string[] = [];
  if (ctx.subject) items.push(ctx.subject);

  switch (phase) {
    case 'start':
      if (ctx.scope) items.push(ctx.scope);
      break;
    case 'tick':
      if (ctx.current !== undefined && ctx.total !== undefined) {
        items.push(`${ctx.current}/${ctx.total}`);
      } else if (ctx.current !== undefined) {
        items.push(String(ctx.current));
      }
      break;
    case 'done':
      if (ctx.scope) items.push(ctx.scope);
      if (ctx.detail) items.push(ctx.detail);
      break;
    case 'fail':
      if (ctx.error) items.push(ctx.error);
      break;
  }

  return items.join('  ');
}

export function plainMessage(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  return body ? `${ctx.label}: ${body}` : `${ctx.label}:`;
}

const SYMBOL_ANSI: Record<Phase, string> = {
  start: `${CYN}${DIM}→${R}`,
  tick: `${GRY}·${R}`,
  done: `${GRN}✓${R}`,
  fail: `${RED}✗${R}`,
};

function colorizeStats(text: string): string {
  return text.replace(/\+(\d+)/g, `${GRN}+$1${R}`).replace(/-(\d+)/g, `${RED}-$1${R}`);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ansiLine(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  const label = `${B}${ctx.label}:${R}`;
  const content = body ? `${label} ${colorizeStats(body)}` : label;
  const timing =
    ctx.durationMs !== undefined ? `  ${DIM}${formatDuration(ctx.durationMs)}${R}` : '';
  return `${SYMBOL_ANSI[phase]}  ${content}${timing}`;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node --test --import tsx/esm "__tests__/unit/fmt.test.ts"
```

Expected: all 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/fmt.ts __tests__/unit/fmt.test.ts
git commit -m "feat: add fmt.ts — plainMessage and ansiLine progress formatters"
```

---

## Task 2: Add `StderrProgressSink` to `observability.ts`

**Files:**

- Modify: `src/core/observability.ts`
- Create: `__tests__/unit/stderr-progress-sink.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `__tests__/unit/stderr-progress-sink.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ProgressCtx } from '../../src/core/fmt.js';
import { StderrProgressSink } from '../../src/core/observability.js';

describe('StderrProgressSink', () => {
  const ctx: ProgressCtx = { label: 'Search', subject: 'async.*await', scope: 'src/' };

  describe('when isTTY is false', () => {
    let origIsTTY: boolean | undefined;
    before(() => {
      origIsTTY = process.stderr.isTTY;
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = false;
    });
    after(() => {
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = origIsTTY as boolean;
    });

    it('emits nothing to stderr', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, () => lines.push('written'));
      sink.emit({ kind: 'tick', current: 45, total: 500, message: 'Search: async.*await  src/' });
      assert.equal(lines.length, 0);
    });
  });

  describe('when isTTY is true', () => {
    let origIsTTY: boolean | undefined;
    before(() => {
      origIsTTY = process.stderr.isTTY;
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = true;
    });
    after(() => {
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = origIsTTY as boolean;
    });

    it('emits a tick line for kind=tick with current > 0', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'tick', current: 45, total: 500, message: '' });
      assert.equal(lines.length, 1);
      assert.ok(lines[0]?.includes('45/500'), `expected "45/500" in: ${lines[0]}`);
    });

    it('emits a start line for kind=tick with current === 0', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'tick', current: 0, message: 'Search: async.*await  src/' });
      assert.equal(lines.length, 1);
      // start symbol → is in the stripped text
      const stripped = lines[0]?.replace(/\x1b\[[0-9;]*m/g, '') ?? '';
      assert.ok(stripped.startsWith('→'), `expected → symbol, got: ${stripped}`);
    });

    it('emits a done line for kind=complete', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'complete', current: 500, message: 'Search: async.*await  src/' });
      const stripped = lines[0]?.replace(/\x1b\[[0-9;]*m/g, '') ?? '';
      assert.ok(stripped.startsWith('✓'), `expected ✓ symbol, got: ${stripped}`);
    });

    it('emits a fail line for kind=fail', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'fail', current: 0, message: '', error: new Error('EACCES') });
      const stripped = lines[0]?.replace(/\x1b\[[0-9;]*m/g, '') ?? '';
      assert.ok(stripped.startsWith('✗'), `expected ✗ symbol`);
      assert.ok(stripped.includes('EACCES'), `expected EACCES in: ${stripped}`);
    });

    it('updateCtx merges partial ctx used on next emit', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.updateCtx({ detail: '23 matches · 8 files' });
      sink.emit({ kind: 'complete', current: 500, message: '' });
      assert.ok(lines[0]?.includes('23 matches · 8 files'), `expected detail in: ${lines[0]}`);
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
node --test --import tsx/esm "__tests__/unit/stderr-progress-sink.test.ts"
```

Expected: fail — `StderrProgressSink` not exported from `observability.js`

- [ ] **Step 3: Add `StderrProgressSink` to `src/core/observability.ts`**

Add these imports at the top of `observability.ts` (after existing imports):

```typescript
import { ansiLine, type Phase, type ProgressCtx } from './fmt.js';
```

Add the class after the `ProgressSession` class definition (at the end of the `--- Progress Session ---` section, before any other section):

```typescript
export class StderrProgressSink implements ProgressSink {
  readonly name = 'stderr';
  readonly #startMs: number;
  #ctx: ProgressCtx;
  readonly #write: (line: string) => void;

  constructor(ctx: ProgressCtx, write?: (line: string) => void) {
    this.#ctx = ctx;
    this.#startMs = Date.now();
    this.#write =
      write ??
      ((line) => {
        process.stderr.write(line + '\n');
      });
  }

  updateCtx(extra: Partial<ProgressCtx>): void {
    this.#ctx = { ...this.#ctx, ...extra };
  }

  emit(event: ProgressEvent): void {
    if (!process.stderr.isTTY && !this.#write) return;

    const phase: Phase =
      event.kind === 'complete'
        ? 'done'
        : event.kind === 'fail'
          ? 'fail'
          : event.kind === 'tick' && event.current === 0
            ? 'start'
            : 'tick';

    const merged: ProgressCtx = {
      ...this.#ctx,
      ...(event.kind === 'tick' || event.kind === 'complete'
        ? { current: event.current, total: event.total }
        : {}),
      ...(event.kind === 'fail'
        ? { error: event.error instanceof Error ? event.error.message : String(event.error) }
        : {}),
      durationMs: Date.now() - this.#startMs,
    };

    try {
      this.#write(ansiLine(phase, merged));
    } catch {
      // never allow observability to affect tool execution
    }
  }
}
```

- [ ] **Step 4: Fix the isTTY guard**

The constructor's `write` parameter is for testing. Fix the guard so it checks `process.stderr.isTTY` at emit time, not construction time, AND skips when the injected `write` is absent and isTTY is false. Update the `emit` method's first line:

```typescript
emit(event: ProgressEvent): void {
  // Skip when not a TTY and no injected writer (test mode uses injected writer)
  if (!process.stderr.isTTY && this.#write === ((line: string) => { process.stderr.write(line + '\n'); })) return;
```

Actually this comparison won't work. Use a simpler flag approach — add a `readonly #ttyOnly: boolean` field:

```typescript
export class StderrProgressSink implements ProgressSink {
  readonly name = 'stderr';
  readonly #startMs: number;
  #ctx: ProgressCtx;
  readonly #writeFn: (line: string) => void;
  readonly #ttyOnly: boolean;

  constructor(ctx: ProgressCtx, writeFn?: (line: string) => void) {
    this.#ctx = ctx;
    this.#startMs = Date.now();
    this.#writeFn =
      writeFn ??
      ((line) => {
        process.stderr.write(line + '\n');
      });
    this.#ttyOnly = writeFn === undefined; // only guard TTY when using real stderr
  }

  updateCtx(extra: Partial<ProgressCtx>): void {
    this.#ctx = { ...this.#ctx, ...extra };
  }

  emit(event: ProgressEvent): void {
    if (this.#ttyOnly && !process.stderr.isTTY) return;

    const phase: Phase =
      event.kind === 'complete'
        ? 'done'
        : event.kind === 'fail'
          ? 'fail'
          : event.kind === 'tick' && event.current === 0
            ? 'start'
            : 'tick';

    const merged: ProgressCtx = {
      ...this.#ctx,
      ...(event.kind === 'tick' || event.kind === 'complete'
        ? { current: event.current, total: event.total }
        : {}),
      ...(event.kind === 'fail'
        ? { error: event.error instanceof Error ? event.error.message : String(event.error) }
        : {}),
      durationMs: Date.now() - this.#startMs,
    };

    try {
      this.#writeFn(ansiLine(phase, merged));
    } catch {
      // never allow observability failures to affect tool execution
    }
  }
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
node --test --import tsx/esm "__tests__/unit/stderr-progress-sink.test.ts"
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/observability.ts __tests__/unit/stderr-progress-sink.test.ts
git commit -m "feat: add StderrProgressSink to observability.ts"
```

---

## Task 3: Fix `src/tasks.ts` — remove double-prefix

**Files:**

- Modify: `src/tasks.ts:209` and `src/tasks.ts:219-222`
- Modify: `__tests__/unit/task-orchestrator.test.ts`

- [ ] **Step 1: Update `task-orchestrator.test.ts` to assert the new behavior**

Open `__tests__/unit/task-orchestrator.test.ts`. Find any assertions that check `statusMessage` contains a `toolName:` prefix (like `"search_content: grep:"` or `"read: starting"`). Change them to assert the message does NOT start with `toolName:` and does not contain the double-prefix pattern.

For example, if a test asserts:

```typescript
assert.ok(statusMessage.startsWith('read: '));
```

Change it to:

```typescript
// statusMessage is now formatted by define.ts, not prefixed by orchestrator
assert.ok(!statusMessage.startsWith('read: read:'), 'no double-prefix');
```

If tests assert `statusMessage === 'toolName: starting'`, change to assert the message is either empty or does not contain the old pattern (the initial message from tasks.ts line 209 is now deleted).

- [ ] **Step 2: Run that test file to confirm it now fails**

```bash
node --test --import tsx/esm "__tests__/unit/task-orchestrator.test.ts"
```

Expected: the assertions you just changed fail.

- [ ] **Step 3: Edit `src/tasks.ts`**

**Delete line 209** (the initial `updateTaskStatus` call):

```typescript
// BEFORE (delete this line):
await task.store.updateTaskStatus(taskId, 'working', `${toolName}: starting`);

// AFTER: remove it entirely — define.ts sends the rich start notification
```

**Fix line 221** (the progress intercept — remove the `toolName:` concatenation):

```typescript
// BEFORE:
await task.store.updateTaskStatus(taskId, status, `${toolName}: ${statusMessage}`);

// AFTER:
await task.store.updateTaskStatus(taskId, status, statusMessage);
```

**Simplify `interceptedOnProgress`** (lines ~230-244) — remove the `message` field reference since `onProgress` will no longer carry messages:

```typescript
// BEFORE:
const interceptedOnProgress = (params: {
  current: number;
  total?: number;
  message?: string;
}) => {
  if (params.message) {
    void interceptedSendNotification({
      method: 'notifications/tasks/status',
      params: { status: 'working', statusMessage: params.message },
    });
  }
};

// AFTER (progress notifications now flow via sendNotification in define.ts):
const interceptedOnProgress = (_params: { current: number; total?: number }): void => {
  // no-op: progress status messages are sent directly via sendNotification in define.ts
};
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/task-orchestrator.test.ts"
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/tasks.ts __tests__/unit/task-orchestrator.test.ts
git commit -m "fix: remove toolName double-prefix from task orchestrator statusMessage"
```

---

## Task 4: Update `src/tools/define.ts` and `src/tools/_helpers.ts`

**Files:**

- Modify: `src/tools/_helpers.ts` (drop `message?` from `ToolContext.onProgress`)
- Modify: `src/tools/define.ts` (`ToolDef` interface + `coreHandler`)

- [ ] **Step 1: Update `_helpers.ts` — drop `message?` from onProgress type**

In `src/tools/_helpers.ts`, find the `ToolContext` interface and update `onProgress`:

```typescript
// BEFORE:
onProgress?: (params: { current: number; total?: number; message?: string }) => void;

// AFTER:
onProgress?: (params: { current: number; total?: number }) => void;
```

- [ ] **Step 2: Add imports to `define.ts`**

At the top of `src/tools/define.ts`, add to the existing imports:

```typescript
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage, StderrProgressSink } from '../core/observability.js';
```

Wait — `StderrProgressSink` is in `observability.ts`, `plainMessage` is in `fmt.ts`. Use:

```typescript
import { plainMessage } from '../core/fmt.js';
import type { ProgressCtx } from '../core/fmt.js';
import { StderrProgressSink } from '../core/observability.js';
```

- [ ] **Step 3: Update `ToolDef` interface in `define.ts`**

Replace the `progressLabel` field with `progress` and `progressDone`:

```typescript
// BEFORE:
readonly progressLabel?: (args: z.infer<I>) => string;

// AFTER:
readonly progress?: (args: z.infer<I>) => ProgressCtx;
readonly progressDone?: (args: z.infer<I>, result: z.infer<O>) => Partial<ProgressCtx>;
```

Also update `ToolCtx.onProgress` to match the type change in `_helpers.ts`:

```typescript
// BEFORE:
readonly onProgress?: (params: { current: number; total?: number; message?: string }) => void;

// AFTER:
readonly onProgress?: (params: { current: number; total?: number }) => void;
```

- [ ] **Step 4: Update `coreHandler` in `define.ts`**

Replace the block starting at `const label = def.progressLabel` through the `onProgress` setup. The full replacement:

```typescript
// BEFORE:
const label = def.progressLabel ? def.progressLabel(parsedArgs) : getDisplayName(def);
const progressSession = new ProgressSession({ label, sinks: [], dynamicRateLimit: true });

const toolCtx: ToolCtx = {
  // ...
  onProgress: (p) => {
    progressUpdates++;
    progressSession.set(p);
    void ctx.sendNotification?.({
      method: 'notifications/tasks/status',
      params: {
        status: 'working',
        ...(p.message ? { statusMessage: p.message } : {}),
      },
    });
  },
  // ...
};
```

```typescript
// AFTER:
const progressCtx: ProgressCtx = def.progress ? def.progress(parsedArgs) : { label: def.title };
const stderrSink = new StderrProgressSink(progressCtx); // ttyOnly=true internally

const progressSession = new ProgressSession({
  label: progressCtx.label,
  sinks: [stderrSink],
  dynamicRateLimit: true,
});

// Send initial start message to MCP client
void ctx.sendNotification?.({
  method: 'notifications/tasks/status',
  params: { status: 'working', statusMessage: plainMessage('start', progressCtx) },
});

const toolCtx: ToolCtx = {
  signal,
  ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
  ...(ctx._meta ? { _meta: ctx._meta } : {}),
  pathGuard: deps.pathGuard,
  resourceStore: deps.resourceStore,
  ...(ctx.log
    ? {
        log: ((ctxLog) => (level, data, logger) => {
          const msg = typeof data === 'string' ? data : String(data);
          Logger.emit(level, msg);
          void ctxLog(level, data, logger);
        })(ctx.log),
      }
    : {}),
  ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
  onProgress: (p) => {
    progressUpdates++;
    const tickCtx: ProgressCtx = {
      ...progressCtx,
      current: p.current,
      ...(p.total !== undefined ? { total: p.total } : {}),
    };
    progressSession.set({ ...p, message: plainMessage('tick', tickCtx) });
    void ctx.sendNotification?.({
      method: 'notifications/tasks/status',
      params: { status: 'working', statusMessage: plainMessage('tick', tickCtx) },
    });
  },
  ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
};
```

- [ ] **Step 5: Update the completion and error paths in `coreHandler`**

Find the `try` block where `def.run` is called. Update `progressSession.complete()` and `progressSession.fail()`:

```typescript
// BEFORE completion:
progressSession.complete(label);

// AFTER completion (inside the try block, after result is obtained):
let doneCtx = progressCtx;
if (def.progressDone) {
  try {
    const extra = def.progressDone(parsedArgs, result.structured);
    doneCtx = { ...progressCtx, ...extra };
    stderrSink.updateCtx(extra);
  } catch {
    // ignore progressDone failures — best effort
  }
}
progressSession.complete(plainMessage('done', doneCtx));
void ctx.sendNotification?.({
  method: 'notifications/tasks/status',
  params: { status: 'working', statusMessage: plainMessage('done', doneCtx) },
});
```

```typescript
// BEFORE failure:
progressSession.fail(error, label);

// AFTER failure (inside the catch block, before building the error return):
const errMsg = error instanceof Error ? error.message : String(error);
stderrSink.updateCtx({ error: errMsg });
progressSession.fail(error, plainMessage('fail', { ...progressCtx, error: errMsg }));
void ctx.sendNotification?.({
  method: 'notifications/tasks/status',
  params: {
    status: 'working',
    statusMessage: plainMessage('fail', { ...progressCtx, error: errMsg }),
  },
});
```

- [ ] **Step 6: Run type-check to confirm no errors**

```bash
node scripts/tasks.mjs check --quick
```

Expected: type-check passes. There will be TypeScript errors in tool files that still reference `progressLabel` — those are addressed in Tasks 5 and 6.

- [ ] **Step 7: Commit**

```bash
git add src/tools/define.ts src/tools/_helpers.ts
git commit -m "feat: wire fmt+StderrProgressSink into define.ts coreHandler"
```

---

## Task 5: Migrate `search-content.ts` and `replace-in-files.ts`

These two tools currently pass a `message` string in `ctx.onProgress`. That field is now removed. They also need `progressLabel` → `progress`.

**Files:**

- Modify: `src/tools/search-content.ts`
- Modify: `src/tools/replace-in-files.ts`

- [ ] **Step 1: Update `search-content.ts`**

Find `progressLabel` and the `onProgress` call in the `run` function.

Replace `progressLabel`:

```typescript
// BEFORE:
progressLabel: (args) => `Search Content: ${truncateProgressPattern(args.searchPattern)}`,

// AFTER:
progress: (args) => ({
  label: 'Search',
  subject: truncateProgressPattern(args.searchPattern),
  scope: args.path ?? '.',
}),
progressDone: (_, result) => ({
  detail: `${result.totalMatches ?? 0} matches · ${result.filesMatched ?? 0} files`,
}),
```

In the `run` function, find the inner `onProgress` callback and remove the `message` field:

```typescript
// BEFORE:
const onProgress = (params: { current: number; total?: number }): void => {
  ctx.onProgress?.({
    current: params.current,
    ...(params.total !== undefined ? { total: params.total } : {}),
    message: `grep: ${truncatedPattern} [${params.current} files]`,
  });
};

// AFTER:
const onProgress = (params: { current: number; total?: number }): void => {
  ctx.onProgress?.({
    current: params.current,
    ...(params.total !== undefined ? { total: params.total } : {}),
  });
};
```

Also remove `const truncatedPattern = truncateProgressPattern(args.searchPattern);` from the top of `run` if it was only used in the old `message` string. Keep it if it's used elsewhere in the function.

Actually, `truncatedPattern` is used in the `summary` string at the end of `run` — keep it.

- [ ] **Step 2: Update `replace-in-files.ts`**

Find `progressLabel`:

```typescript
// BEFORE:
progressLabel: (args) => {
  const dryLabel = args.dryRun ? ' [dry run]' : '';
  const scope = args.pattern ?? args.path ?? '**/*';
  return `Search and Replace: "${truncateProgressPattern(args.searchPattern)}" in ${scope}${dryLabel}`;
},

// AFTER:
progress: (args) => {
  const dryLabel = args.dryRun ? ' [dry run]' : '';
  return {
    label: `Replace${dryLabel}`,
    subject: `"${truncateProgressPattern(args.searchPattern)}" → "${truncateProgressPattern(args.replacement)}"`,
    scope: args.path ?? args.pattern ?? '.',
  };
},
progressDone: (_, result) => ({
  detail: `${result.filesModified} files · ${result.totalMatches} matches`,
}),
```

The `onProgress` calls in `replace-in-files.ts` already only pass `{ current }` without a `message` — they need no changes.

- [ ] **Step 3: Run type-check**

```bash
node scripts/tasks.mjs check --quick
```

Expected: no errors in these two files.

- [ ] **Step 4: Commit**

```bash
git add src/tools/search-content.ts src/tools/replace-in-files.ts
git commit -m "feat: migrate search-content and replace-in-files to progress/progressDone"
```

---

## Task 6: Migrate remaining 9 tool files

**Files:**

- Modify: `src/tools/read.ts`
- Modify: `src/tools/edit.ts`
- Modify: `src/tools/search-files.ts`
- Modify: `src/tools/list.ts`
- Modify: `src/tools/create.ts`
- Modify: `src/tools/move.ts`
- Modify: `src/tools/delete-file.ts`
- Modify: `src/tools/calculate-hash.ts`
- Modify: `src/tools/stat.ts`

Pattern for each: find `progressLabel`, replace with `progress` returning a `ProgressCtx` literal, add `progressDone` where result stats are available.

- [ ] **Step 1: Migrate `read.ts`**

```typescript
// BEFORE:
progressLabel: buildReadProgressLabel,

// AFTER (replace both the field and delete the buildReadProgressLabel function):
progress: (args) => {
  const isBatch = args.paths !== undefined;
  if (isBatch) {
    return { label: 'Read', subject: `${String(args.paths?.length ?? 0)} files` };
  }
  const name = basename(args.path ?? '');
  if (args.offset !== undefined) {
    const end = args.length !== undefined ? args.offset + args.length - 1 : '…';
    return { label: 'Read', subject: `${name} [bytes ${args.offset}–${String(end)}]` };
  }
  if (args.startLine !== undefined) {
    return { label: 'Read', subject: `${name} [lines ${args.startLine}–${String(args.endLine ?? '…')}]` };
  }
  if (args.head !== undefined) return { label: 'Read', subject: `${name} [head ${args.head}]` };
  if (args.tail !== undefined) return { label: 'Read', subject: `${name} [tail ${args.tail}]` };
  return { label: 'Read', subject: name };
},
progressDone: (_, result) => {
  if (result.bytesRead !== undefined) {
    return { detail: formatBytes(result.bytesRead) };
  }
  return {};
},
```

Delete the `buildReadProgressLabel` function and the `READ_TOOL_LABEL` constant if it is only used there (check for other usages first).

- [ ] **Step 2: Migrate `edit.ts`**

```typescript
// BEFORE:
progressLabel: buildEditProgressMessage,

// AFTER:
progress: (args) => {
  const tag = args.dryRun ? ' [dry run]' : '';
  if (args.path !== undefined) return { label: `Edit${tag}`, subject: basename(args.path) };
  if (args.paths !== undefined) return { label: `Edit${tag}`, subject: `${args.paths.length} files` };
  if (args.files !== undefined) return { label: `Edit${tag}`, subject: `${args.files.length} files` };
  return { label: `Edit${tag}` };
},
progressDone: (_, result) => {
  // Multi-file: result.files array
  if (result.files && result.files.length > 0) {
    const parts = result.files.map(
      (f: { path: string; linesAdded?: number; linesRemoved?: number }) =>
        `${basename(f.path)}+${f.linesAdded ?? 0}-${f.linesRemoved ?? 0}`,
    );
    return { subject: parts.join(' · ') };
  }
  // Single file: result.path + result.linesAdded / result.linesRemoved
  if (result.path) {
    return {
      subject: `${basename(result.path)}+${result.linesAdded ?? 0}-${result.linesRemoved ?? 0}`,
    };
  }
  return {};
},
```

Delete the `buildEditProgressMessage` function.

- [ ] **Step 3: Migrate `search-files.ts`**

```typescript
// BEFORE:
progressLabel: (args) => {
  const scopeLabel = (args.path ? basename(args.path) : '.') || '.';
  return `Find Files: ${truncateProgressPattern(args.pattern)} in ${scopeLabel}`;
},

// AFTER:
progress: (args) => ({
  label: 'Find',
  subject: truncateProgressPattern(args.pattern),
  scope: args.path ? basename(args.path) : '.',
}),
progressDone: (_, result) => ({
  detail: `${result.results.length} files`,
}),
```

- [ ] **Step 4: Migrate `list.ts`**

```typescript
// BEFORE:
progressLabel: (args) => {
  const path = args.path;
  return `List: ${path ? basename(path) : '.'}`;
},

// AFTER:
progress: (args) => ({
  label: 'List',
  subject: args.path ? basename(args.path) : '.',
}),
progressDone: (_, result) => ({
  detail: `${result.totalEntries} entries`,
}),
```

- [ ] **Step 5: Migrate `create.ts`**

```typescript
// BEFORE:
progressLabel: (args) => {
  if (args.files.length === 1) {
    return `Create Files: ${basename(args.files[0]?.path ?? '')}`;
  }
  return `Create Files: ${args.files.length} files`;
},

// AFTER:
progress: (args) => {
  if (args.files.length === 1) {
    return { label: 'Create', subject: basename(args.files[0]?.path ?? '') };
  }
  return { label: 'Create', subject: `${args.files.length} files` };
},
```

No `progressDone` needed — subject from args is sufficient.

- [ ] **Step 6: Migrate `move.ts`**

```typescript
// BEFORE:
progressLabel: (args) => {
  if (args.moves.length === 1) {
    const move = args.moves[0];
    return `Move Files: ${basename(move?.source ?? '')} -> ${basename(move?.destination ?? '')}`;
  }
  return `Move Files: ${args.moves.length} files`;
},

// AFTER:
progress: (args) => {
  if (args.moves.length === 1) {
    const move = args.moves[0];
    return {
      label: 'Move',
      subject: `${basename(move?.source ?? '')} → ${basename(move?.destination ?? '')}`,
    };
  }
  return { label: 'Move', subject: `${args.moves.length} files` };
},
```

- [ ] **Step 7: Migrate `delete-file.ts`**

```typescript
// BEFORE:
progressLabel: (args) => `Delete File: ${args.paths.map((p) => basename(p)).join(', ')}`,

// AFTER:
progress: (args) => ({
  label: 'Delete',
  subject: args.paths.map((p) => basename(p)).join(' · '),
}),
```

- [ ] **Step 8: Migrate `calculate-hash.ts`**

```typescript
// BEFORE:
progressLabel: (args) => `Calculate Hash: ${basename(args.path)}`,

// AFTER:
progress: (args) => ({
  label: 'Hash',
  subject: basename(args.path),
}),
```

No `progressDone` — the hash value is shown in the result text.

- [ ] **Step 9: Migrate `stat.ts`**

```typescript
// BEFORE:
progressLabel: (args) => {
  if (args.paths !== undefined) {
    return `Get File Info: ${args.paths.length} paths`;
  }
  // ... single path case
},

// AFTER:
progress: (args) => {
  if (args.paths !== undefined) {
    return { label: 'Stat', subject: `${args.paths.length} paths` };
  }
  return { label: 'Stat', subject: args.path ? basename(args.path) : '.' };
},
```

- [ ] **Step 10: Run type-check**

```bash
node scripts/tasks.mjs check --quick
```

Expected: zero TypeScript errors.

- [ ] **Step 11: Commit**

```bash
git add src/tools/read.ts src/tools/edit.ts src/tools/search-files.ts \
  src/tools/list.ts src/tools/create.ts src/tools/move.ts \
  src/tools/delete-file.ts src/tools/calculate-hash.ts src/tools/stat.ts
git commit -m "feat: migrate all tool progressLabel definitions to progress/progressDone"
```

---

## Task 7: Full check and fix

- [ ] **Step 1: Run full check**

```bash
node scripts/tasks.mjs check
```

Expected: format → lint → type-check → test → rebuild all pass with zero errors.

- [ ] **Step 2: Fix any remaining type errors or test failures**

If type errors: look at the file and line reported. Common causes:

- A tool file still has `progressLabel` — rename to `progress` and update return type to `ProgressCtx`
- A test that checked for `"toolName: starting"` in a status message — update assertion to match the new `plainMessage('start', ...)` format
- `result.files` access in `edit.ts:progressDone` — the `files` field is on multi-file output; guard with `result.files && result.files.length > 0` (already done in Task 6 Step 2)

If lint errors: run `node scripts/tasks.mjs fix` to auto-fix formatting.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "fix: resolve remaining type errors and test failures from progress redesign"
```

---

## Self-Review Notes

**Spec coverage check:**

- `fmt.ts` plainMessage + ansiLine: Task 1 ✓
- StderrProgressSink: Task 2 ✓
- tasks.ts double-prefix removal: Task 3 ✓
- define.ts ToolDef + coreHandler wiring: Task 4 ✓
- search-content inline message removal: Task 5 ✓
- replace-in-files inline message removal: Task 5 ✓
- All 11 tool progressLabel migrations: Tasks 5–6 ✓
- \_helpers.ts onProgress type: Task 4 Step 1 ✓
- progressDone for edit (per-file +N-N): Task 6 Step 2 ✓
- progressDone for search-content: Task 5 ✓

**Type consistency check:**

- `ProgressCtx` defined in `fmt.ts`, imported with `import type` where only type-used ✓
- `plainMessage(phase: Phase, ctx: ProgressCtx)` — Phase and ProgressCtx used consistently ✓
- `StderrProgressSink.updateCtx(extra: Partial<ProgressCtx>)` — matches usage in Task 4 ✓
- `progressDone` receives `z.infer<O>` — tools reference correct output type fields ✓
- `onProgress` type narrowed to `{ current, total? }` (no message) in both ToolContext and ToolCtx ✓
