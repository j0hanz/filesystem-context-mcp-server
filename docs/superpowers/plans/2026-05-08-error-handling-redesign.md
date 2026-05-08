# Error Handling Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current dual-taxonomy error system (Zod issues + `ErrorCode` + message-string sniffing) with a single `Problem` model classified deterministically from errno/AbortSignal/ZodError, surfaced on the wire with structured `issues[]`, and powered by Zod 4's native `z.toJSONSchema` overrides.

**Architecture:** Three layers (handler → classifier → serializer). `Problem` is the single typed shape; `McpError` is a thin throwable carrier with back-compat constructor overload. Suggestions resolve from schema `.meta()` first, then rule `params`, then a per-code default. JSON Schema cleanup moves from a hand-rolled `walk()` recursion to Zod 4's per-node `override` callback plus one named post-pass for cross-property concerns.

**Tech Stack:** TypeScript (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`), Zod 4 (via `zod/v4` subpath), `node:test` runner via `tsx/esm`, `@modelcontextprotocol/server` v2.

**Spec:** [docs/superpowers/specs/2026-05-08-error-handling-redesign-design.md](../specs/2026-05-08-error-handling-redesign-design.md)

---

## File Structure

| File                                 | Status      | Responsibility                                                                                                                               |
| ------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/problem.ts`                 | **create**  | `Problem`/`ProblemIssue`/`ProblemDetails` types, `classify()`, `Problem.*` factories, `zodErrorToProblem()`, `walkCauseChain()`, `ERRNO_MAP` |
| `src/lib/error-suggestions.ts`       | **create**  | `resolveSuggestion()`, `DEFAULT_SUGGESTIONS`, `suggestionFromIssueMeta()`                                                                    |
| `src/lib/errors.ts`                  | **modify**  | `McpError` becomes thin carrier wrapping `Problem`; deletes ~150 LOC of message sniffing + errno reverse-lookup                              |
| `src/config.ts`                      | **modify**  | Add `VALIDATION_FAILED`, `IO_ERROR` to `ErrorCode`                                                                                           |
| `src/schemas/json-schema.ts`         | **modify**  | Replace `walk()` recursion with Zod 4 `override` callback                                                                                    |
| `src/schemas/fields.ts`              | **modify**  | Add `.meta({ suggestion })` to `SafeGlobPattern` and 2 other shared fields                                                                   |
| `src/schemas/shared.ts`              | **modify**  | `validateReadRange` issues carry `params: { rule, conflictsWith, suggestion }`                                                               |
| `src/tools/shared.ts`                | **modify**  | `parseToolArgs` emits `VALIDATION_FAILED`; `buildToolErrorResponse` serializes `issues[]`                                                    |
| `src/index.ts`                       | **modify**  | `z.config(z.locales.en())` at bootstrap                                                                                                      |
| `__tests__/unit/problem.test.ts`     | **create**  | Classifier table, Zod→Problem, suggestion precedence, wire serialization                                                                     |
| `__tests__/unit/errors.test.ts`      | **rewrite** | New shape; locks "no message sniffing" property; locks errno fixes                                                                           |
| `__tests__/tools/read-write.test.ts` | **modify**  | Lines 512, 604, 702, 726: flip `'INVALID_INPUT'` → `'VALIDATION_FAILED'`                                                                     |
| `__tests__/tools/directory.test.ts`  | **modify**  | Lines 382, 394: same flip                                                                                                                    |

---

## Task 1: Add new ErrorCode values + scaffold `Problem` types

**Files:**

- Modify: `src/config.ts` (lines 105-118)
- Create: `src/lib/problem.ts`
- Create: `__tests__/unit/problem.test.ts`

- [ ] **Step 1.1: Add new codes to `ErrorCode`**

Modify `src/config.ts`:

```ts
export const ErrorCode = {
  ACCESS_DENIED: 'ACCESS_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  NOT_FILE: 'NOT_FILE',
  NOT_DIRECTORY: 'NOT_DIRECTORY',
  TOO_LARGE: 'TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  INVALID_PATTERN: 'INVALID_PATTERN',
  INVALID_INPUT: 'INVALID_INPUT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  IO_ERROR: 'IO_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;
```

- [ ] **Step 1.2: Write the failing classifier test (smallest case)**

Create `__tests__/unit/problem.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/config.js';
import { classify, Problem } from '../../src/lib/problem.js';

describe('classify', () => {
  it('returns UNKNOWN for non-Error values', () => {
    assert.equal(classify(undefined).code, ErrorCode.UNKNOWN);
    assert.equal(classify(null).code, ErrorCode.UNKNOWN);
    assert.equal(classify('plain string').code, ErrorCode.UNKNOWN);
    assert.equal(classify({}).code, ErrorCode.UNKNOWN);
  });

  it('returns IO_ERROR for plain Error with no errno and no cause', () => {
    assert.equal(classify(new Error('boom')).code, ErrorCode.IO_ERROR);
  });

  it('does NOT classify by message substring', () => {
    // Locks the no-sniffing property.
    assert.equal(
      classify(new Error('permission denied')).code,
      ErrorCode.IO_ERROR
    );
    assert.equal(
      classify(new Error('no such file or directory')).code,
      ErrorCode.IO_ERROR
    );
    assert.equal(
      classify(new Error('operation timed out')).code,
      ErrorCode.IO_ERROR
    );
  });
});

describe('Problem factories', () => {
  it('Problem.notFound builds a NOT_FOUND problem', () => {
    const p = Problem.notFound('missing', { path: '/x' });
    assert.equal(p.code, ErrorCode.NOT_FOUND);
    assert.equal(p.message, 'missing');
    assert.equal(p.path, '/x');
  });
});
```

- [ ] **Step 1.3: Run test — expect failure (module does not exist)**

Run:

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: all tests fail with `Cannot find module '../../src/lib/problem.js'`.

- [ ] **Step 1.4: Create `src/lib/problem.ts` with types and factories**

Create `src/lib/problem.ts`:

```ts
import { ErrorCode } from '../config.js';

export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly issues?: readonly ProblemIssue[];
  readonly suggestion?: string;
  readonly details?: ProblemDetails;
}

export interface ProblemIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ProblemDetails {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
  readonly errno?: string;
  readonly syscall?: string;
  readonly tool?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

interface ProblemFactoryOptions {
  path?: string;
  suggestion?: string;
  details?: ProblemDetails;
  issues?: readonly ProblemIssue[];
}

function build(
  code: ErrorCode,
  message: string,
  opts: ProblemFactoryOptions = {}
): Problem {
  return {
    code,
    message,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.suggestion !== undefined ? { suggestion: opts.suggestion } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
    ...(opts.issues !== undefined ? { issues: opts.issues } : {}),
  };
}

export const Problem = {
  notFound: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.NOT_FOUND, msg, o),
  invalidInput: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.INVALID_INPUT, msg, o),
  accessDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.ACCESS_DENIED, msg, o),
  permissionDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.PERMISSION_DENIED, msg, o),
  timeout: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.TIMEOUT, msg, o),
  cancelled: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.CANCELLED, msg, o),
  tooLarge: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.TOO_LARGE, msg, o),
  ioError: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.IO_ERROR, msg, o),
  unknown: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.UNKNOWN, msg, o),
} as const;

// Stub: real classifier comes in Task 2.
export function classify(error: unknown): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (!(error instanceof Error)) {
    return Problem.unknown(String(error));
  }
  return Problem.ioError(error.message);
}
```

- [ ] **Step 1.5: Run test — expect pass**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.6: Type-check**

```sh
npm run type-check
```

Expected: 0 errors.

- [ ] **Step 1.7: Commit**

```sh
git add src/config.ts src/lib/problem.ts __tests__/unit/problem.test.ts
git commit -m "feat(errors): add VALIDATION_FAILED + IO_ERROR codes and scaffold Problem model"
```

---

## Task 2: Implement errno-driven classifier (no message sniffing)

**Files:**

- Modify: `src/lib/problem.ts`
- Modify: `__tests__/unit/problem.test.ts`

- [ ] **Step 2.1: Write failing tests for the errno table**

Append to `__tests__/unit/problem.test.ts`:

```ts
function makeErrno(code: string, message = 'fake'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('classify — errno table', () => {
  const cases: Array<[string, ErrorCode]> = [
    ['ENOENT', ErrorCode.NOT_FOUND],
    ['EACCES', ErrorCode.PERMISSION_DENIED],
    ['EPERM', ErrorCode.PERMISSION_DENIED],
    ['ENOTDIR', ErrorCode.NOT_DIRECTORY],
    ['EISDIR', ErrorCode.NOT_FILE],
    ['ELOOP', ErrorCode.SYMLINK_NOT_ALLOWED],
    ['ENAMETOOLONG', ErrorCode.INVALID_INPUT],
    ['ETIMEDOUT', ErrorCode.TIMEOUT],
    ['ENOTEMPTY', ErrorCode.NOT_DIRECTORY],
    ['EEXIST', ErrorCode.INVALID_INPUT],
    ['EINVAL', ErrorCode.INVALID_INPUT],
  ];
  for (const [errno, expected] of cases) {
    it(`${errno} → ${expected}`, () => {
      assert.equal(classify(makeErrno(errno)).code, expected);
    });
  }
});

describe('classify — errno fixes (regression locks)', () => {
  it('EMFILE → IO_ERROR (was TIMEOUT)', () => {
    assert.equal(classify(makeErrno('EMFILE')).code, ErrorCode.IO_ERROR);
  });
  it('ENFILE → IO_ERROR (was TIMEOUT)', () => {
    assert.equal(classify(makeErrno('ENFILE')).code, ErrorCode.IO_ERROR);
  });
  it('EBUSY → IO_ERROR (was PERMISSION_DENIED)', () => {
    assert.equal(classify(makeErrno('EBUSY')).code, ErrorCode.IO_ERROR);
  });
});

describe('classify — abort & timeout', () => {
  it('AbortError name → CANCELLED', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    assert.equal(classify(e).code, ErrorCode.CANCELLED);
  });
  it('code ABORT_ERR → CANCELLED', () => {
    const e = makeErrno('ABORT_ERR');
    assert.equal(classify(e).code, ErrorCode.CANCELLED);
  });
  it('TimeoutError name → TIMEOUT', () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    assert.equal(classify(e).code, ErrorCode.TIMEOUT);
  });
});

describe('classify — cause chain', () => {
  it('walks .cause to find errno', () => {
    const inner = makeErrno('ENOENT');
    const outer = new Error('wrapper', { cause: inner });
    assert.equal(classify(outer).code, ErrorCode.NOT_FOUND);
  });
  it('terminates on first abort hit even if outer has errno cause', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const outer = new Error('wrapper', { cause: abort });
    assert.equal(classify(outer).code, ErrorCode.CANCELLED);
  });
});

describe('classify — Problem details propagate errno', () => {
  it('records errno + syscall in details', () => {
    const e = makeErrno('ENOENT');
    e.syscall = 'open';
    const p = classify(e);
    assert.equal(p.details?.errno, 'ENOENT');
    assert.equal(p.details?.syscall, 'open');
  });
});
```

- [ ] **Step 2.2: Run tests — expect failure**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: errno-table tests, abort/timeout tests, and cause-chain tests fail.

- [ ] **Step 2.3: Replace stub `classify` with the real implementation**

Replace the `classify` stub at the bottom of `src/lib/problem.ts` with:

```ts
const ERRNO_MAP: Readonly<Record<string, ErrorCode>> = {
  ENOENT: ErrorCode.NOT_FOUND,
  EACCES: ErrorCode.PERMISSION_DENIED,
  EPERM: ErrorCode.PERMISSION_DENIED,
  ENOTDIR: ErrorCode.NOT_DIRECTORY,
  EISDIR: ErrorCode.NOT_FILE,
  ELOOP: ErrorCode.SYMLINK_NOT_ALLOWED,
  ENAMETOOLONG: ErrorCode.INVALID_INPUT,
  ETIMEDOUT: ErrorCode.TIMEOUT,
  EMFILE: ErrorCode.IO_ERROR,
  ENFILE: ErrorCode.IO_ERROR,
  EBUSY: ErrorCode.IO_ERROR,
  ENOTEMPTY: ErrorCode.NOT_DIRECTORY,
  EEXIST: ErrorCode.INVALID_INPUT,
  EINVAL: ErrorCode.INVALID_INPUT,
};

const ERRNO_RE = /^E[A-Z]+$/;

type ClassificationSignal =
  | { kind: 'abort' }
  | { kind: 'timeout' }
  | { kind: 'errno'; errno: string; syscall?: string; path?: string }
  | { kind: 'unknown' };

function readErrnoCode(value: unknown): string | undefined {
  if (!(value instanceof Error)) return undefined;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string') return undefined;
  return code;
}

function isAbortSingle(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'AbortError') return true;
  const code = readErrnoCode(value);
  return code === 'ABORT_ERR';
}

function isTimeoutSingle(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  if (value.name === 'TimeoutError') return true;
  return readErrnoCode(value) === 'ETIMEDOUT';
}

function readSignalSingle(value: unknown): ClassificationSignal | undefined {
  if (isAbortSingle(value)) return { kind: 'abort' };
  if (isTimeoutSingle(value)) return { kind: 'timeout' };
  const code = readErrnoCode(value);
  if (code !== undefined && ERRNO_RE.test(code)) {
    const v = value as NodeJS.ErrnoException;
    return {
      kind: 'errno',
      errno: code,
      ...(typeof v.syscall === 'string' ? { syscall: v.syscall } : {}),
      ...(typeof v.path === 'string' ? { path: v.path } : {}),
    };
  }
  return undefined;
}

function walkCauseChain(error: unknown): ClassificationSignal {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let abortSeen = false;
  let timeoutSeen = false;
  let errnoSignal: ClassificationSignal | undefined;

  while (current !== undefined && current !== null && !visited.has(current)) {
    const signal = readSignalSingle(current);
    if (signal !== undefined) {
      if (signal.kind === 'abort') abortSeen = true;
      else if (signal.kind === 'timeout') timeoutSeen = true;
      else if (signal.kind === 'errno' && errnoSignal === undefined) {
        errnoSignal = signal;
      }
    }
    if (!(current instanceof Error)) break;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  if (abortSeen) return { kind: 'abort' };
  if (timeoutSeen) return { kind: 'timeout' };
  if (errnoSignal !== undefined) return errnoSignal;
  return { kind: 'unknown' };
}

function buildProblemFromSignal(
  signal: ClassificationSignal,
  error: unknown
): Problem {
  const message = error instanceof Error ? error.message : String(error);
  switch (signal.kind) {
    case 'abort':
      return Problem.cancelled(message);
    case 'timeout':
      return Problem.timeout(message);
    case 'errno': {
      const code = ERRNO_MAP[signal.errno] ?? ErrorCode.IO_ERROR;
      const details: ProblemDetails = {
        errno: signal.errno,
        ...(signal.syscall !== undefined ? { syscall: signal.syscall } : {}),
      };
      return build(code, message, {
        ...(signal.path !== undefined ? { path: signal.path } : {}),
        details,
      });
    }
    case 'unknown':
      return Problem.ioError(message);
  }
}

export function classify(error: unknown): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (!(error instanceof Error)) {
    return Problem.unknown(String(error));
  }
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}
```

- [ ] **Step 2.4: Run tests — expect pass**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: all tests pass.

- [ ] **Step 2.5: Run all tests — confirm no regressions in unaffected tests**

```sh
npm run test
```

Expected: all green (existing `errors.test.ts` still uses old `McpError` constructor; we haven't touched it yet).

- [ ] **Step 2.6: Commit**

```sh
git add src/lib/problem.ts __tests__/unit/problem.test.ts
git commit -m "feat(errors): errno-driven classifier with no message sniffing"
```

---

## Task 3: ZodError → Problem with structured `issues[]`

**Files:**

- Modify: `src/lib/problem.ts`
- Modify: `__tests__/unit/problem.test.ts`

- [ ] **Step 3.1: Write failing tests**

Append to `__tests__/unit/problem.test.ts`:

```ts
import { z } from 'zod/v4';

import { zodErrorToProblem } from '../../src/lib/problem.js';

describe('zodErrorToProblem', () => {
  it('maps a Zod validation error to VALIDATION_FAILED with issues[]', () => {
    const schema = z.strictObject({ name: z.string().min(3) });
    const result = schema.safeParse({ name: 'a' });
    assert.equal(result.success, false);
    if (result.success) return;

    const p = zodErrorToProblem(result.error);
    assert.equal(p.code, ErrorCode.VALIDATION_FAILED);
    assert.ok(p.issues && p.issues.length >= 1);
    const first = p.issues[0]!;
    assert.deepEqual([...first.path], ['name']);
    assert.equal(first.code, 'too_small');
  });

  it('preserves custom params from superRefine issues', () => {
    const schema = z
      .strictObject({ a: z.string().optional(), b: z.string().optional() })
      .superRefine((value, ctx) => {
        if (value.a !== undefined && value.b !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['a'],
            message: "Cannot use 'a' with 'b'",
            params: {
              rule: 'mutually_exclusive',
              conflictsWith: ['b'],
              suggestion: 'Pick one.',
            },
          });
        }
      });
    const result = schema.safeParse({ a: 'x', b: 'y' });
    assert.equal(result.success, false);
    if (result.success) return;

    const p = zodErrorToProblem(result.error);
    const issue = p.issues?.[0];
    assert.equal(issue?.code, 'custom');
    assert.equal(issue?.params?.['rule'], 'mutually_exclusive');
    assert.deepEqual(issue?.params?.['conflictsWith'], ['b']);
  });

  it('classify(ZodError) routes through zodErrorToProblem', () => {
    const schema = z.strictObject({ x: z.number() });
    const result = schema.safeParse({ x: 'nope' });
    if (result.success) return;
    assert.equal(classify(result.error).code, ErrorCode.VALIDATION_FAILED);
  });
});
```

- [ ] **Step 3.2: Run — expect failure**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: `zodErrorToProblem` import fails, classify-ZodError test fails.

- [ ] **Step 3.3: Add Zod handling to `src/lib/problem.ts`**

Add at the top of `src/lib/problem.ts`:

```ts
import { z } from 'zod/v4';
```

Add the function (place above `classify`):

```ts
function toProblemIssue(issue: z.core.$ZodIssue): ProblemIssue {
  const base: ProblemIssue = {
    path: issue.path.map(String),
    code: issue.code ?? 'custom',
    message: issue.message,
  };
  const expected = (issue as { expected?: unknown }).expected;
  const received = (issue as { received?: unknown }).received;
  const params = (issue as { params?: unknown }).params;
  return {
    ...base,
    ...(expected !== undefined ? { expected: String(expected) } : {}),
    ...(received !== undefined ? { received: String(received) } : {}),
    ...(params && typeof params === 'object'
      ? { params: params as Record<string, unknown> }
      : {}),
  };
}

export function zodErrorToProblem(err: z.ZodError): Problem {
  const issues = err.issues.map(toProblemIssue);
  return build(ErrorCode.VALIDATION_FAILED, z.prettifyError(err), { issues });
}
```

Wire it into `classify` — replace the existing `classify` function head:

```ts
export function classify(error: unknown): Problem {
  if (error === null || error === undefined) {
    return Problem.unknown('Unknown error');
  }
  if (error instanceof z.ZodError) return zodErrorToProblem(error);
  if (!(error instanceof Error)) {
    return Problem.unknown(String(error));
  }
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}
```

- [ ] **Step 3.4: Run — expect pass**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: all green.

- [ ] **Step 3.5: Commit**

```sh
git add src/lib/problem.ts __tests__/unit/problem.test.ts
git commit -m "feat(errors): zodErrorToProblem produces VALIDATION_FAILED with structured issues"
```

---

## Task 4: Suggestion resolver (3-source precedence)

**Files:**

- Create: `src/lib/error-suggestions.ts`
- Modify: `__tests__/unit/problem.test.ts`

- [ ] **Step 4.1: Write failing tests for suggestion precedence**

Append to `__tests__/unit/problem.test.ts`:

```ts
import { resolveSuggestion } from '../../src/lib/error-suggestions.js';

describe('resolveSuggestion', () => {
  it('returns per-code default when no issues and no schema', () => {
    const s = resolveSuggestion({ code: ErrorCode.NOT_FOUND, issues: [] });
    assert.equal(typeof s, 'string');
    assert.ok(s!.length > 0);
  });

  it('returns undefined for VALIDATION_FAILED with no issues + no schema', () => {
    assert.equal(
      resolveSuggestion({ code: ErrorCode.VALIDATION_FAILED, issues: [] }),
      undefined
    );
  });

  it('rule-params suggestion wins over per-code default', () => {
    const s = resolveSuggestion({
      code: ErrorCode.VALIDATION_FAILED,
      issues: [
        {
          path: ['head'],
          code: 'custom',
          message: 'conflict',
          params: { suggestion: 'Use line ranges OR head, not both.' },
        },
      ],
    });
    assert.equal(s, 'Use line ranges OR head, not both.');
  });

  it('schema-meta suggestion wins over rule-params and default', () => {
    const schema = z.strictObject({
      pattern: z.string().min(1).meta({ suggestion: 'meta wins' }),
    });
    const s = resolveSuggestion(
      {
        code: ErrorCode.VALIDATION_FAILED,
        issues: [
          {
            path: ['pattern'],
            code: 'too_small',
            message: 'min',
            params: { suggestion: 'rule loses' },
          },
        ],
      },
      schema
    );
    assert.equal(s, 'meta wins');
  });
});
```

- [ ] **Step 4.2: Run — expect failure**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: import fails.

- [ ] **Step 4.3: Create `src/lib/error-suggestions.ts`**

```ts
import { z } from 'zod/v4';

import { ErrorCode } from '../config.js';
import type { Problem, ProblemIssue } from './problem.js';

const DEFAULT_SUGGESTIONS: Readonly<Partial<Record<ErrorCode, string>>> = {
  [ErrorCode.ACCESS_DENIED]: 'Run roots to list allowed directories.',
  [ErrorCode.NOT_FOUND]: 'Run ls or find to verify the path.',
  [ErrorCode.NOT_FILE]: 'Target is a directory, not a file.',
  [ErrorCode.NOT_DIRECTORY]: 'Target is a file, not a directory.',
  [ErrorCode.TOO_LARGE]: 'Use head/tail or line ranges to read partially.',
  [ErrorCode.TIMEOUT]: 'Reduce scope, depth, or maxResults.',
  [ErrorCode.INVALID_PATTERN]: 'Check syntax and escape special characters.',
  [ErrorCode.PERMISSION_DENIED]: 'Check OS file permissions.',
  [ErrorCode.SYMLINK_NOT_ALLOWED]: 'Symlink escapes allowed directories.',
};

function readSuggestionMeta(schema: z.ZodType | undefined): string | undefined {
  if (!schema) return undefined;
  const meta = z.globalRegistry.get(schema) as
    | { suggestion?: unknown }
    | undefined;
  if (meta && typeof meta.suggestion === 'string') return meta.suggestion;
  return undefined;
}

function descend(
  schema: z.ZodType,
  segment: string | number
): z.ZodType | undefined {
  const def = (schema as unknown as { _def?: unknown })._def as
    | { shape?: Record<string, z.ZodType>; type?: z.ZodType }
    | undefined;
  if (!def) return undefined;
  if (typeof segment === 'string' && def.shape && segment in def.shape) {
    return def.shape[segment];
  }
  if (typeof segment === 'number' && def.type) return def.type;
  return undefined;
}

function suggestionFromIssueMeta(
  schema: z.ZodType,
  issue: ProblemIssue
): string | undefined {
  let cursor: z.ZodType | undefined = schema;
  const trail: Array<z.ZodType | undefined> = [cursor];
  for (const segment of issue.path) {
    cursor = cursor ? descend(cursor, segment) : undefined;
    trail.push(cursor);
  }
  // Walk leaf → root, return first .meta().suggestion found.
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const found = readSuggestionMeta(trail[i]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function resolveSuggestion(
  p: Pick<Problem, 'code' | 'issues'>,
  schema?: z.ZodType
): string | undefined {
  if (p.issues && p.issues.length > 0 && schema) {
    for (const issue of p.issues) {
      const fromMeta = suggestionFromIssueMeta(schema, issue);
      if (fromMeta) return fromMeta;
    }
  }
  if (p.issues && p.issues.length > 0) {
    for (const issue of p.issues) {
      const fromRule = issue.params?.['suggestion'];
      if (typeof fromRule === 'string') return fromRule;
    }
  }
  return DEFAULT_SUGGESTIONS[p.code];
}

export { DEFAULT_SUGGESTIONS };
```

- [ ] **Step 4.4: Wire `resolveSuggestion` into `zodErrorToProblem`**

Modify `src/lib/problem.ts`. Update the function signature and import:

```ts
import { resolveSuggestion } from './error-suggestions.js';

export function zodErrorToProblem(
  err: z.ZodError,
  schema?: z.ZodType
): Problem {
  const issues = err.issues.map(toProblemIssue);
  const suggestion = resolveSuggestion(
    { code: ErrorCode.VALIDATION_FAILED, issues },
    schema
  );
  return build(ErrorCode.VALIDATION_FAILED, z.prettifyError(err), {
    issues,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
}
```

Update `classify` to forward an optional schema:

```ts
export function classify(
  error: unknown,
  ctx?: { schema?: z.ZodType }
): Problem {
  if (error === null || error === undefined)
    return Problem.unknown('Unknown error');
  if (error instanceof z.ZodError) return zodErrorToProblem(error, ctx?.schema);
  if (!(error instanceof Error)) return Problem.unknown(String(error));
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}
```

- [ ] **Step 4.5: Run all problem tests — expect pass**

```sh
node --test --import tsx/esm __tests__/unit/problem.test.ts
```

Expected: all green.

- [ ] **Step 4.6: Type-check**

```sh
npm run type-check
```

Expected: 0 errors.

- [ ] **Step 4.7: Commit**

```sh
git add src/lib/error-suggestions.ts src/lib/problem.ts __tests__/unit/problem.test.ts
git commit -m "feat(errors): suggestion resolver with schema-meta > rule-params > default precedence"
```

---

## Task 5: `McpError` becomes thin carrier (back-compat overload)

**Files:**

- Modify: `src/lib/errors.ts`
- Modify: `__tests__/unit/errors.test.ts` (rewrite later in Task 9; here just keep it green)

- [ ] **Step 5.1: Replace `src/lib/errors.ts` body**

Replace the entire contents of `src/lib/errors.ts` with the following. This deletes the message-sniffing classifier, the errno reverse-lookup, and the static suggestion table; re-exports come from `problem.ts`/`error-suggestions.ts` for back-compat.

```ts
import { ErrorCode } from '../config.js';
import { DEFAULT_SUGGESTIONS, resolveSuggestion } from './error-suggestions.js';
import { getTraceContext } from './observability.js';
import {
  classify as classifyProblem,
  Problem,
  type ProblemDetails,
  type ProblemIssue,
} from './problem.js';

export { ErrorCode };
export { Problem, type ProblemIssue, type ProblemDetails };

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string';
}

export function isAbortError(error: unknown): boolean {
  return classifyProblem(error).code === ErrorCode.CANCELLED;
}

export function isTimeoutLikeError(error: unknown): boolean {
  return classifyProblem(error).code === ErrorCode.TIMEOUT;
}

export function classifyError(error: unknown): ErrorCode {
  return classifyProblem(error).code;
}

export function getSuggestion(code: ErrorCode): string | undefined {
  return DEFAULT_SUGGESTIONS[code];
}

interface DetailedError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
  details?: Record<string, unknown>;
  issues?: readonly ProblemIssue[];
}

export function createDetailedError(
  error: unknown,
  path?: string,
  additional?: Record<string, unknown>
): DetailedError {
  const problem = classifyProblem(error);
  const trace = getTraceContext();
  const merged: Record<string, unknown> = {
    ...(trace ?? {}),
    ...(problem.details ?? {}),
    ...(additional ?? {}),
  };
  // Strip the `extra` wrapper if present so existing consumers see flat keys.
  if (problem.details?.extra) {
    Object.assign(merged, problem.details.extra);
    delete (merged as { extra?: unknown }).extra;
  }
  const out: DetailedError = {
    code: problem.code,
    message: problem.message,
    ...((path ?? problem.path)
      ? { path: (path ?? problem.path) as string }
      : {}),
    ...(problem.suggestion !== undefined
      ? { suggestion: problem.suggestion }
      : {}),
    ...(Object.keys(merged).length > 0 ? { details: merged } : {}),
    ...(problem.issues ? { issues: problem.issues } : {}),
  };
  return out;
}

export function formatDetailedError(error: DetailedError): string {
  const lines: string[] = [`${error.code}: ${error.message}`];
  if (error.path && !error.message.includes(error.path)) lines.push(error.path);
  if (error.suggestion) lines.push(error.suggestion);
  return lines.join('\n');
}

export function formatUnknownErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function normalizeUnknownError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(formatUnknownErrorMessage(error));
}

// `McpError` carries a `Problem`. The legacy 5-arg positional constructor is
// preserved as an overload so existing throw sites keep compiling.
export class McpError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem, cause?: unknown);
  constructor(
    code: ErrorCode,
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  );
  constructor(
    arg1: Problem | ErrorCode,
    arg2?: string | unknown,
    arg3?: string,
    arg4?: Record<string, unknown>,
    arg5?: unknown
  ) {
    if (typeof arg1 === 'string') {
      // Legacy positional form.
      const code = arg1;
      const message = String(arg2 ?? '');
      const path = arg3;
      const detailsArg = arg4;
      const cause = arg5;
      const trace = getTraceContext();
      const details: ProblemDetails | undefined =
        trace || detailsArg
          ? {
              ...(trace?.traceparent !== undefined
                ? { traceparent: trace.traceparent }
                : {}),
              ...(trace?.tracestate !== undefined
                ? { tracestate: trace.tracestate }
                : {}),
              ...(trace?.baggage !== undefined
                ? { baggage: trace.baggage }
                : {}),
              ...(detailsArg
                ? { extra: detailsArg as Record<string, unknown> }
                : {}),
            }
          : undefined;
      const problem: Problem = {
        code,
        message,
        ...(path !== undefined ? { path } : {}),
        ...(details !== undefined ? { details } : {}),
        suggestion: DEFAULT_SUGGESTIONS[code],
      };
      super(message, cause === undefined ? {} : { cause });
      this.problem = problem;
    } else {
      // New form: McpError(problem, cause?)
      const problem = arg1;
      const cause = arg2;
      super(problem.message, cause === undefined ? {} : { cause });
      this.problem = problem;
    }
    this.name = 'McpError';
    Object.setPrototypeOf(this, McpError.prototype);
  }

  get code(): ErrorCode {
    return this.problem.code;
  }
  get path(): string | undefined {
    return this.problem.path;
  }
  get details(): Record<string, unknown> | undefined {
    if (!this.problem.details) return undefined;
    const { extra, ...rest } = this.problem.details;
    if (!extra) return Object.keys(rest).length > 0 ? rest : undefined;
    return { ...rest, ...extra };
  }

  static notFound(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.NOT_FOUND, message, path, details, cause);
  }
  static invalidInput(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.INVALID_INPUT, message, path, details, cause);
  }
  static accessDenied(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.ACCESS_DENIED, message, path, details, cause);
  }
  static timeout(
    message: string,
    path?: string,
    details?: Record<string, unknown>,
    cause?: unknown
  ): McpError {
    return new McpError(ErrorCode.TIMEOUT, message, path, details, cause);
  }
}

export { resolveSuggestion };
```

- [ ] **Step 5.2: Update `classify` callers in `problem.ts` to honor `McpError` passthrough**

In `src/lib/problem.ts`, update `classify` to short-circuit when given an `McpError`. Add this import block at the top (after the existing imports):

```ts
// Lazy import avoids circular load: errors.ts re-exports from this module.
function isMcpError(error: unknown): error is { problem: Problem } {
  return (
    error instanceof Error &&
    error.name === 'McpError' &&
    'problem' in error &&
    typeof (error as { problem?: unknown }).problem === 'object'
  );
}
```

And in `classify`:

```ts
export function classify(
  error: unknown,
  ctx?: { schema?: z.ZodType }
): Problem {
  if (error === null || error === undefined)
    return Problem.unknown('Unknown error');
  if (isMcpError(error)) return error.problem;
  if (error instanceof z.ZodError) return zodErrorToProblem(error, ctx?.schema);
  if (!(error instanceof Error)) return Problem.unknown(String(error));
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}
```

- [ ] **Step 5.3: Add a passthrough test**

Append to `__tests__/unit/problem.test.ts`:

```ts
import { McpError } from '../../src/lib/errors.js';

describe('classify — McpError passthrough', () => {
  it('returns the carried problem unchanged', () => {
    const original = Problem.notFound('hi', { path: '/x' });
    const err = new McpError(original);
    const out = classify(err);
    assert.equal(out.code, ErrorCode.NOT_FOUND);
    assert.equal(out.path, '/x');
  });
});
```

- [ ] **Step 5.4: Run full test suite — expect green**

```sh
npm run test
```

Expected: all green. The existing `__tests__/unit/errors.test.ts` still uses the legacy positional constructor, which works via the overload.

- [ ] **Step 5.5: Lint + type-check**

```sh
npm run lint
npm run type-check
```

Expected: 0 errors.

- [ ] **Step 5.6: Commit**

```sh
git add src/lib/errors.ts src/lib/problem.ts __tests__/unit/problem.test.ts
git commit -m "refactor(errors): McpError becomes thin Problem carrier with back-compat overload"
```

---

## Task 6: JSON Schema pipeline — replace `walk()` with Zod 4 `override`

**Files:**

- Modify: `src/schemas/json-schema.ts`

- [ ] **Step 6.1: Capture current snapshot baseline**

```sh
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

Expected: pass. This baseline is what we must not drift from.

- [ ] **Step 6.2: Rewrite `src/schemas/json-schema.ts`**

Replace the entire file with:

```ts
import { fromJsonSchema } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

type JsonSchema = Record<string, unknown>;

const NONSTANDARD_FORMATS = new Set(['base64url', 'sha256_hex']);

const JSON_SCHEMA_OVERRIDE: NonNullable<
  Parameters<typeof z.toJSONSchema>[1]
>['override'] = (ctx) => {
  const out = ctx.jsonSchema as JsonSchema;
  if (out.format === 'date-time' && 'pattern' in out) delete out.pattern;
  if (out.type === 'integer' && out.maximum === Number.MAX_SAFE_INTEGER) {
    delete out.maximum;
  }
  if (
    typeof out.format === 'string' &&
    NONSTANDARD_FORMATS.has(out.format) &&
    'pattern' in out
  ) {
    delete out.format;
  }
  if ('contentEncoding' in out && 'pattern' in out) delete out.contentEncoding;
};

function removeDefaultedFromRequired(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(removeDefaultedFromRequired);
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema as JsonSchema)) {
    out[k] = removeDefaultedFromRequired(v);
  }
  if (
    Array.isArray(out.required) &&
    out.properties &&
    typeof out.properties === 'object'
  ) {
    const props = out.properties as Record<string, JsonSchema>;
    const filtered = (out.required as string[]).filter(
      (n) => !('default' in (props[n] ?? {}))
    );
    if (filtered.length === 0) delete out.required;
    else out.required = filtered;
  }
  return out;
}

function stripRootSchema(schema: JsonSchema): JsonSchema {
  if ('$schema' in schema) {
    const { $schema: _drop, ...rest } = schema;
    return rest;
  }
  return schema;
}

export function readRangeConstraints(): JsonSchema[] {
  return [
    { not: { required: ['head', 'tail'] } },
    { not: { required: ['tail', 'startLine'] } },
    { not: { required: ['tail', 'endLine'] } },
    { not: { required: ['head', 'startLine'] } },
    { not: { required: ['head', 'endLine'] } },
    { not: { required: ['offset', 'head'] } },
    { not: { required: ['offset', 'tail'] } },
    { not: { required: ['offset', 'startLine'] } },
    { not: { required: ['offset', 'endLine'] } },
    { not: { required: ['length', 'head'] } },
    { not: { required: ['length', 'tail'] } },
    { not: { required: ['length', 'startLine'] } },
    { not: { required: ['length', 'endLine'] } },
  ];
}

export function safeGlobConstraint(propertyName: string): JsonSchema {
  return {
    if: { required: [propertyName] },
    then: {
      properties: {
        [propertyName]: {
          not: {
            anyOf: [
              { pattern: '^/' },
              { pattern: '^[A-Za-z]:' },
              { pattern: '\\.\\.' },
            ],
          },
        },
      },
    },
  };
}

export function toToolJsonSchema(
  zodSchema: z.ZodType,
  augment?: (schema: JsonSchema) => JsonSchema
): ReturnType<typeof fromJsonSchema> {
  const raw = z.toJSONSchema(zodSchema, {
    io: 'input',
    unrepresentable: 'any',
    override: JSON_SCHEMA_OVERRIDE,
  }) as JsonSchema;
  const cleaned = removeDefaultedFromRequired(
    stripRootSchema(raw)
  ) as JsonSchema;
  const final = augment ? augment(cleaned) : cleaned;
  return fromJsonSchema(final);
}
```

- [ ] **Step 6.3: Run snapshot test**

```sh
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

Expected: pass with no snapshot drift. **If drift occurs**, manually inspect the diff in `__tests__/schemas/__snapshots__/`. Drift is acceptable only if every change is one of: pattern stripped from datetime, maximum stripped from integer at MAX_SAFE_INTEGER, format stripped on `base64url`/`sha256_hex` with pattern, $schema stripped at root, defaulted-required cleanup. If anything else changed, fix the override; do not update the snapshot.

If drift is acceptable, regenerate snapshots:

```sh
$env:UPDATE_SNAPSHOTS = '1'; node --test --import tsx/esm __tests__/schemas/snapshot.test.ts; Remove-Item Env:UPDATE_SNAPSHOTS
```

- [ ] **Step 6.4: Run full test suite**

```sh
npm run test
```

Expected: all green.

- [ ] **Step 6.5: Commit**

```sh
git add src/schemas/json-schema.ts __tests__/schemas/__snapshots__/
git commit -m "refactor(schemas): replace hand-rolled walk() with Zod 4 native JSON Schema override"
```

---

## Task 7: Validation surface — `parseToolArgs` emits `VALIDATION_FAILED` with issues

**Files:**

- Modify: `src/tools/shared.ts`
- Modify: `src/schemas/shared.ts` (`validateReadRange`)
- Modify: `__tests__/tools/read-write.test.ts` (4 lines)
- Modify: `__tests__/tools/directory.test.ts` (2 lines)

- [ ] **Step 7.1: Update `parseToolArgs` to use the new pipeline**

In `src/tools/shared.ts`, find `parseToolArgs` (around line 349). Replace:

```ts
function parseToolArgs<Schema extends z.ZodType>(
  schema: Schema,
  args: unknown
): z.infer<Schema> {
  const candidate = args === undefined ? {} : args;
  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }

  throw new McpError(
    ErrorCode.INVALID_INPUT,
    `Invalid tool arguments:\n${z.prettifyError(parsed.error)}`
  );
}
```

with:

```ts
function parseToolArgs<Schema extends z.ZodType>(
  schema: Schema,
  args: unknown
): z.infer<Schema> {
  const candidate = args === undefined ? {} : args;
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  throw new McpError(zodErrorToProblem(parsed.error, schema));
}
```

Add the import at the top of `src/tools/shared.ts` (next to the existing `errors.js` import):

```ts
import { zodErrorToProblem } from '../lib/problem.js';
```

- [ ] **Step 7.2: Update the catch in `withValidatedArgs`**

Still in `src/tools/shared.ts`, find:

```ts
if (error instanceof McpError && error.code === ErrorCode.INVALID_INPUT) {
  return buildToolErrorResponse(error, ErrorCode.INVALID_INPUT);
}
```

Replace with:

```ts
if (
  error instanceof McpError &&
  (error.code === ErrorCode.INVALID_INPUT ||
    error.code === ErrorCode.VALIDATION_FAILED)
) {
  return buildToolErrorResponse(error, error.code);
}
```

- [ ] **Step 7.3: Update `buildToolErrorResponse` to surface `issues[]` on the wire**

In `src/tools/shared.ts`, find `buildToolErrorResponse` (around line 596) and replace with:

```ts
export function buildToolErrorResponse(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string
): ToolErrorResponse {
  const detailed = resolveDetailedError(error, defaultCode, path);
  const text = formatDetailedError(detailed);
  const structuredError: Record<string, unknown> = {
    code: detailed.code,
    message: detailed.message,
    ...(detailed.path !== undefined ? { path: detailed.path } : {}),
    ...(detailed.suggestion !== undefined
      ? { suggestion: detailed.suggestion }
      : {}),
    ...(detailed.issues && detailed.issues.length > 0
      ? { issues: detailed.issues }
      : {}),
  };
  return {
    content: [{ type: 'text', text }],
    isError: true,
    errorCode: detailed.code,
    error: structuredError,
  };
}
```

Note: existing `errorCode` top-level field is preserved (consumed by `define-tool.test.ts:303,351,421,456` and `shared.test.ts`). The new `error` field is additive and contains `issues[]`.

- [ ] **Step 7.4: Update `validateReadRange` to emit structured params**

In `src/schemas/shared.ts`, replace each `ctx.addIssue` call:

```ts
ctx.addIssue({
  code: 'custom',
  path: ['head'],
  message: "Cannot use 'head' with 'startLine'/'endLine'",
  input: value,
  params: {
    rule: 'mutually_exclusive',
    conflictsWith: ['startLine', 'endLine'],
    suggestion: 'Use line ranges OR head, not both.',
  },
});
```

And:

```ts
ctx.addIssue({
  code: 'custom',
  path: ['tail'],
  message: "Cannot use 'tail' with 'head'/'startLine'/'endLine'",
  input: value,
  params: {
    rule: 'mutually_exclusive',
    conflictsWith: ['head', 'startLine', 'endLine'],
    suggestion: 'Use line ranges OR tail, not both.',
  },
});
```

And:

```ts
ctx.addIssue({
  code: 'custom',
  path: ['endLine'],
  message: "'endLine' must be >= 'startLine'",
  input: value,
  params: { rule: 'order', minField: 'startLine' },
});
```

And:

```ts
ctx.addIssue({
  code: 'custom',
  path: ['offset'],
  message:
    "Cannot use 'offset'/'length' with line-based params (head/tail/startLine/endLine)",
  input: value,
  params: {
    rule: 'mutually_exclusive',
    conflictsWith: ['head', 'tail', 'startLine', 'endLine'],
    suggestion: 'Use byte range OR line range, not both.',
  },
});
```

- [ ] **Step 7.5: Verify which test assertions are Zod failures (not path-guard)**

For each of `__tests__/tools/read-write.test.ts:512`, `:604`, `:702`, `:726` and `__tests__/tools/directory.test.ts:382`, `:394`:

Read 5 lines of context above each assertion. If the test invokes a tool with arguments that fail Zod schema validation (e.g. negative integer where `min(0)` is required, or `startLine=10, endLine=1`), it's a Zod failure → flip to `'VALIDATION_FAILED'`. If the test passes valid args but expects rejection due to e.g. an empty path becoming an `INVALID_INPUT` from `path-guard.ts`, leave as `'INVALID_INPUT'`.

Document each verdict inline in the commit message.

- [ ] **Step 7.6: Run full test suite — expect 6 failures (now they're VALIDATION_FAILED)**

```sh
npm run test
```

Expected: ~6 assertion failures with messages like `expected 'INVALID_INPUT' but got 'VALIDATION_FAILED'`. Any other failures indicate a deeper regression — stop and investigate.

- [ ] **Step 7.7: Flip the verified Zod-failure assertions**

For each verified Zod-failure line, change the second arg of `assertToolError`:

```ts
// Before
assertToolError(raw, 'INVALID_INPUT');
// After
assertToolError(raw, 'VALIDATION_FAILED');
```

- [ ] **Step 7.8: Run full test suite — expect green**

```sh
npm run test
```

Expected: all green.

- [ ] **Step 7.9: Manual smoke test via inspector**

```sh
npm run inspector
```

In a separate shell call `read` with an invalid path (empty string). Confirm the response contains:

- `errorCode: "VALIDATION_FAILED"` (or `INVALID_INPUT` depending on which path-guard hits)
- `error.issues: [...]` populated when the failure is a Zod failure
- Pretty-printed multi-line text content

Close the inspector with Ctrl+C.

- [ ] **Step 7.10: Commit**

```sh
git add src/tools/shared.ts src/schemas/shared.ts __tests__/tools/read-write.test.ts __tests__/tools/directory.test.ts
git commit -m "feat(errors): VALIDATION_FAILED with structured issues[] on the wire; rule params for read-range conflicts"
```

---

## Task 8: Schema-attached suggestions via `.meta()`

**Files:**

- Modify: `src/schemas/fields.ts`

- [ ] **Step 8.1: Add `.meta({ suggestion })` to `SafeGlobPattern`**

In `src/schemas/fields.ts`, find `SafeGlobPattern` and update its `.meta` block:

```ts
export const SafeGlobPattern = z
  .string()
  .min(1, 'Pattern required')
  .max(1000, 'Max 1000 chars')
  .refine((val) => isSafeGlobSyntax(val), {
    error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
  })
  .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")')
  .meta({
    id: 'SafeGlobPattern',
    title: 'Glob Pattern',
    examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'],
    suggestion:
      'Use forward-slash globs; absolute paths and ".." are forbidden.',
  });
```

- [ ] **Step 8.2: Add `.meta({ suggestion })` to `RequiredPath`/`OptionalPath`**

Replace the `PathBase`/`OptionalPath`/`RequiredPath` block:

```ts
const PathBase = z
  .string()
  .min(1, 'Path required')
  .max(MAX_PATH_LENGTH, `Path too long (max ${MAX_PATH_LENGTH} chars)`)
  .describe('Path inside an allowed root');

const PATH_SUGGESTION =
  'Path must be inside an allowed root. Run roots to list them.';

export const OptionalPath = PathBase.optional().meta({
  suggestion: PATH_SUGGESTION,
});
export const RequiredPath = PathBase.meta({ suggestion: PATH_SUGGESTION });
```

- [ ] **Step 8.3: Run snapshot test — confirm no JSON Schema drift**

```sh
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

Expected: pass. (`.meta()` keys are kept by Zod 4 in the global registry but should not appear in JSON Schema output unless we put them in known keys like `description`/`examples`. `suggestion` is a custom key and should be filtered by Zod's JSON Schema converter — verify in snapshot output.)

If `suggestion` leaks into JSON Schema output, add to `JSON_SCHEMA_OVERRIDE` in `src/schemas/json-schema.ts`:

```ts
delete (out as { suggestion?: unknown }).suggestion;
```

- [ ] **Step 8.4: Run full test suite**

```sh
npm run test
```

Expected: all green.

- [ ] **Step 8.5: Commit**

```sh
git add src/schemas/fields.ts src/schemas/json-schema.ts __tests__/schemas/__snapshots__/
git commit -m "feat(errors): schema-attached suggestions on SafeGlobPattern and Path fields"
```

---

## Task 9: Rewrite `__tests__/unit/errors.test.ts`

**Files:**

- Rewrite: `__tests__/unit/errors.test.ts`

- [ ] **Step 9.1: Rewrite the test file**

Replace the entire content of `__tests__/unit/errors.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  classifyError,
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
  isAbortError,
  isNodeError,
  isTimeoutLikeError,
  McpError,
  Problem,
} from '../../src/lib/errors.js';

// ─── isNodeError ────────────────────────────────────────────────────────────

describe('isNodeError', () => {
  it('returns true for system errors with a string code', () => {
    let err: NodeJS.ErrnoException | undefined;
    try {
      readdirSync(`/nonexistent-${Date.now()}`);
    } catch (e: unknown) {
      err = e as NodeJS.ErrnoException;
    }
    assert.ok(err !== undefined);
    assert.equal(isNodeError(err), true);
  });

  it('returns false for plain Error', () => {
    assert.equal(isNodeError(new Error('plain')), false);
  });

  it('returns false for primitives', () => {
    assert.equal(isNodeError('s'), false);
    assert.equal(isNodeError(null), false);
    assert.equal(isNodeError(undefined), false);
    assert.equal(isNodeError({}), false);
  });
});

// ─── McpError (legacy positional + new Problem) ─────────────────────────────

describe('McpError — legacy positional constructor', () => {
  it('stores code and message', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'file not found');
    assert.equal(err.code, ErrorCode.NOT_FOUND);
    assert.equal(err.message, 'file not found');
    assert.ok(err instanceof Error);
  });

  it('has name "McpError"', () => {
    const err = new McpError(ErrorCode.PERMISSION_DENIED, 'no access');
    assert.equal(err.name, 'McpError');
  });

  it('stores optional path', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'msg', '/some/path');
    assert.equal(err.path, '/some/path');
  });

  it('returns undefined path when not provided', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'msg');
    assert.equal(err.path, undefined);
  });
});

describe('McpError — Problem constructor', () => {
  it('wraps a Problem', () => {
    const p = Problem.notFound('missing', { path: '/x' });
    const err = new McpError(p);
    assert.equal(err.code, ErrorCode.NOT_FOUND);
    assert.equal(err.path, '/x');
    assert.equal(err.problem, p);
  });

  it('preserves cause', () => {
    const inner = new Error('inner');
    const p = Problem.ioError('outer');
    const err = new McpError(p, inner);
    assert.equal(err.cause, inner);
  });
});

// ─── getSuggestion ──────────────────────────────────────────────────────────

describe('getSuggestion', () => {
  it('returns string or undefined for every code', () => {
    for (const code of Object.values(ErrorCode)) {
      const s = getSuggestion(code);
      if (s !== undefined) {
        assert.equal(typeof s, 'string');
        assert.ok(s.length > 0);
      }
    }
  });

  it('returns the same value for known codes (locks regression)', () => {
    assert.equal(
      getSuggestion(ErrorCode.NOT_FOUND),
      'Run ls or find to verify the path.'
    );
    assert.equal(
      getSuggestion(ErrorCode.PERMISSION_DENIED),
      'Check OS file permissions.'
    );
  });
});

// ─── classifyError ──────────────────────────────────────────────────────────

describe('classifyError — no message sniffing', () => {
  // Property: classification is errno-driven, never message-driven.
  it('plain Error("permission denied") → IO_ERROR (NOT PERMISSION_DENIED)', () => {
    assert.equal(
      classifyError(new Error('permission denied')),
      ErrorCode.IO_ERROR
    );
  });
  it('plain Error("no such file") → IO_ERROR (NOT NOT_FOUND)', () => {
    assert.equal(
      classifyError(new Error('no such file or directory')),
      ErrorCode.IO_ERROR
    );
  });
  it('plain Error("timed out") → IO_ERROR (NOT TIMEOUT)', () => {
    assert.equal(
      classifyError(new Error('operation timed out')),
      ErrorCode.IO_ERROR
    );
  });
});

// ─── isAbortError / isTimeoutLikeError ──────────────────────────────────────

describe('isAbortError', () => {
  it('detects AbortError name', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    assert.equal(isAbortError(e), true);
  });
  it('detects ABORT_ERR code', () => {
    const e = Object.assign(new Error('a'), { code: 'ABORT_ERR' });
    assert.equal(isAbortError(e), true);
  });
  it('rejects plain Error with abort word in message', () => {
    assert.equal(isAbortError(new Error('aborted by user')), false);
  });
});

describe('isTimeoutLikeError', () => {
  it('detects TimeoutError name', () => {
    const e = new Error('t');
    e.name = 'TimeoutError';
    assert.equal(isTimeoutLikeError(e), true);
  });
  it('detects ETIMEDOUT code', () => {
    const e = Object.assign(new Error('t'), { code: 'ETIMEDOUT' });
    assert.equal(isTimeoutLikeError(e), true);
  });
  it('rejects plain Error with timeout word', () => {
    assert.equal(isTimeoutLikeError(new Error('timed out')), false);
  });
});

// ─── createDetailedError ────────────────────────────────────────────────────

describe('createDetailedError', () => {
  it('classifies an ENOENT into NOT_FOUND with suggestion', () => {
    const e = Object.assign(new Error('no'), { code: 'ENOENT' });
    const d = createDetailedError(e, '/a');
    assert.equal(d.code, ErrorCode.NOT_FOUND);
    assert.equal(d.path, '/a');
    assert.ok(d.suggestion?.length);
  });

  it('formats human-readable text', () => {
    const e = Object.assign(new Error('msg'), { code: 'EACCES' });
    const d = createDetailedError(e, '/x');
    const text = formatDetailedError(d);
    assert.ok(text.includes('PERMISSION_DENIED'));
    assert.ok(text.includes('msg'));
  });
});

// ─── Errno fixes (regression locks) ─────────────────────────────────────────

describe('classifyError — errno fixes', () => {
  it('EMFILE → IO_ERROR (was TIMEOUT)', () => {
    const e = Object.assign(new Error('many'), { code: 'EMFILE' });
    assert.equal(classifyError(e), ErrorCode.IO_ERROR);
  });
  it('ENFILE → IO_ERROR (was TIMEOUT)', () => {
    const e = Object.assign(new Error('many'), { code: 'ENFILE' });
    assert.equal(classifyError(e), ErrorCode.IO_ERROR);
  });
  it('EBUSY → IO_ERROR (was PERMISSION_DENIED)', () => {
    const e = Object.assign(new Error('busy'), { code: 'EBUSY' });
    assert.equal(classifyError(e), ErrorCode.IO_ERROR);
  });
});
```

- [ ] **Step 9.2: Run the file**

```sh
node --test --import tsx/esm __tests__/unit/errors.test.ts
```

Expected: all green.

- [ ] **Step 9.3: Run full test suite**

```sh
npm run test
```

Expected: all green.

- [ ] **Step 9.4: Commit**

```sh
git add __tests__/unit/errors.test.ts
git commit -m "test(errors): rewrite errors.test.ts against Problem model with no-sniffing locks"
```

---

## Task 10: Locale seam + cleanup

**Files:**

- Modify: `src/index.ts`
- Possibly delete: unused helpers flagged by knip

- [ ] **Step 10.1: Add locale config to bootstrap**

In `src/index.ts`, add near the top of the entry function (after imports, before any tool registration):

```ts
import { z } from 'zod/v4';

z.config(z.locales.en());
```

If `z` is already imported elsewhere in `src/index.ts`, just add the `z.config(z.locales.en())` line at the appropriate place.

- [ ] **Step 10.2: Run knip to find unused exports**

```sh
npx knip
```

Look specifically for unused exports from `src/lib/errors.ts`:

- `formatDetailedError` — used by `buildToolErrorResponse`, keep
- `formatUnknownErrorMessage` — verify with grep; if unused outside tests, delete
- `normalizeUnknownError` — verify with grep
- `getSuggestion` — used by `tools/shared.ts:resolveDetailedError`, keep
- `createDetailedError` — used by `tools/shared.ts:resolveDetailedError`, keep
- `classifyError` — used by external callers; keep as re-export

If knip flags any of these as unused, delete them.

- [ ] **Step 10.3: Run the full task chain**

```sh
node scripts/tasks.mjs
```

Expected: format → lint → type-check → knip → test → build, all pass.

- [ ] **Step 10.4: Commit**

```sh
git add src/index.ts src/lib/errors.ts
git commit -m "chore(errors): add locale seam and prune unused helpers"
```

---

## Task 11: Acceptance verification

**No code changes — verifies the spec acceptance criteria.**

- [ ] **Step 11.1: Full task chain**

```sh
node scripts/tasks.mjs
```

Expected: green.

- [ ] **Step 11.2: Confirm no message sniffing remains**

```sh
git grep -nE "lower\.includes|message\.includes" src/lib/errors.ts src/lib/problem.ts
```

Expected: zero hits.

- [ ] **Step 11.3: Confirm dead code is gone**

```sh
git grep -nE "classifyMessageError|walkErrorChain" src/
```

Expected: zero hits.

- [ ] **Step 11.4: Confirm no `walk()` recursion remains in JSON Schema pipeline**

```sh
git grep -n "function walk" src/schemas/json-schema.ts
```

Expected: zero hits.

- [ ] **Step 11.5: Confirm structured `issues[]` reaches the wire**

```sh
npm run inspector
```

In another shell, call any tool with invalid args (e.g. `read` with `path: ''`). Verify the response `structuredContent.error` (or top-level `error` field — depends on SDK serialization) contains `issues: [...]` with at least one entry having `path`, `code`, `message`. Close inspector with Ctrl+C.

- [ ] **Step 11.6: Confirm errno fixes**

The unit tests in Task 2 and Task 9 already lock these in. Re-run:

```sh
node --test --import tsx/esm --test-name-pattern="errno fixes" __tests__/unit/
```

Expected: pass.

- [ ] **Step 11.7: Final commit (if any cleanup needed)**

```sh
git status
```

If everything is committed, no action. Otherwise commit residual changes.

---

## Self-Review Checklist

- ✅ **Spec coverage:** Every section of the spec (§3 architecture, §4 data model, §5 classification, §6 JSON Schema, §7 suggestions, §8 ergonomics, §9 locale, §10 testing, §11 rollout, §14 acceptance) maps to one or more tasks above. The 6-step rollout in spec §11 is implemented as Tasks 1-2 (step 1+2 of spec — new files), Task 5 (step 2 — McpError reroute), Task 6 (step 3), Task 7 (step 4), Tasks 8-9 (step 5), Task 10 (step 6). Acceptance criteria are Task 11.

- ✅ **Placeholder scan:** No `TBD`, no `// TODO`, no "implement later". Every code-changing step has the actual code or the exact path-and-line reference. The one "verify which lines are Zod failures" decision in Step 7.5 is scoped with explicit verification criteria.

- ✅ **Type consistency:** `Problem`, `ProblemIssue`, `ProblemDetails` types match across Tasks 1, 3, 4, 5. `classify(error, ctx?: { schema })` signature is consistent across Tasks 2, 3, 4, 5. `Problem.*` factory names (`notFound`, `invalidInput`, `accessDenied`, `permissionDenied`, `timeout`, `cancelled`, `tooLarge`, `ioError`, `unknown`) defined once in Task 1 and used unchanged.
