# Collapse Tool Result Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `_kind: 'wrapped'` sentinel + wrap/unwrap ceremony in `_helpers.ts` / `define.ts` with a clean `RunResult<T>` shape `{ structured, text?, resources? }`, move error-normalization to `Problem.fromUnknown`, and delete the resulting dead code.

**Architecture:** `define.ts` owns the single seam between tool handlers and the MCP `CallToolResult` envelope. Tools return `RunResult<T>` directly; `define.ts` adapts it to `CallToolResult`. `Problem.fromUnknown` in `core/errors.ts` becomes the single place that normalises `unknown` errors into the per-item `PerFileError` shape used by batch tools.

**Tech Stack:** TypeScript (strict ESM), Zod v4, Node.js built-in test runner (`node --test`), `node scripts/tasks.mjs` dev-loop.

---

## File Map

| Action | File                                              | What changes                                                                        |
| ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Modify | `src/core/errors.ts`                              | Add `Problem.fromUnknown` static method                                             |
| Modify | `src/tools/define.ts`                             | Redefine `RunResult<T>`, replace duck-typed unwrap, inline `buildToolErrorResponse` |
| Modify | `src/tools/_helpers.ts`                           | Transitional shims → then full deletion of wrap/error helpers + `require*`          |
| Modify | `src/tools/calculate-hash.ts`                     | Return `RunResult<T>` directly                                                      |
| Modify | `src/tools/create.ts`                             | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `src/tools/delete-file.ts`                        | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `src/tools/edit.ts`                               | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `src/tools/list.ts`                               | Return `RunResult<T>` directly                                                      |
| Modify | `src/tools/move.ts`                               | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `src/tools/read.ts`                               | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `src/tools/replace-in-files.ts`                   | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `src/tools/roots.ts`                              | Return `RunResult<T>` directly                                                      |
| Modify | `src/tools/search-content.ts`                     | Return `RunResult<T>` directly                                                      |
| Modify | `src/tools/search-files.ts`                       | Return `RunResult<T>` directly                                                      |
| Modify | `src/tools/stat.ts`                               | Return `RunResult<T>`, use `Problem.fromUnknown`                                    |
| Modify | `__tests__/unit/define-tool.test.ts`              | Update `BASE_DEF.run` to new shape, drop `buildToolResponse` import                 |
| Modify | `__tests__/unit/shared-resource-response.test.ts` | Delete `buildResourceResponse` test, keep `putResource` tests                       |

---

## Task 1 — Add `Problem.fromUnknown` to `src/core/errors.ts`

**Files:**

- Modify: `src/core/errors.ts`
- Test: `__tests__/unit/errors.test.ts`

### Background

`buildStructuredError` in `_helpers.ts` (and its private helper `resolveDetailedError`) normalises an `unknown` thrown value into `{ code, message, path?, suggestion? }` matching `PerFileErrorSchema`. This logic belongs next to the `Problem` namespace in `core/errors.ts`. The new method is `Problem.fromUnknown(error, defaultCode, path?)`.

Behavioural spec:

- Call `createDetailedError(error, path)`.
- If the resulting code is `UNKNOWN` or `IO_ERROR`, replace it with `defaultCode` and pick a suggestion via `getSuggestion(defaultCode)`.
- Return `{ code, message, path?, suggestion? }` — no `issues` or `details` (to stay within `PerFileErrorSchema`'s strict shape).

- [ ] **Step 1: Write the failing test in `__tests__/unit/errors.test.ts`**

Add this block at the end of the file (after all existing `describe` blocks):

```typescript
describe('Problem.fromUnknown', () => {
  it('returns code and message for a plain Error', () => {
    const err = new Error('boom');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN);
    assert.equal(result.code, ErrorCode.UNKNOWN);
    assert.equal(result.message, 'boom');
    assert.equal(result.path, undefined);
    assert.equal(result.suggestion, undefined);
  });

  it('overrides UNKNOWN code with defaultCode', () => {
    const err = new Error('something went wrong');
    const result = Problem.fromUnknown(err, ErrorCode.NOT_FOUND);
    assert.equal(result.code, ErrorCode.NOT_FOUND);
  });

  it('overrides IO_ERROR code with defaultCode', () => {
    const ioErr = Object.assign(new Error('io'), { code: 'EMFILE' });
    const result = Problem.fromUnknown(ioErr, ErrorCode.TOO_LARGE);
    assert.equal(result.code, ErrorCode.TOO_LARGE);
  });

  it('preserves specific error codes (e.g. NOT_FOUND from ENOENT)', () => {
    const notFound = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const result = Problem.fromUnknown(notFound, ErrorCode.UNKNOWN);
    assert.equal(result.code, ErrorCode.NOT_FOUND);
  });

  it('includes path when provided', () => {
    const err = new Error('oops');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN, '/some/path');
    assert.equal(result.path, '/some/path');
  });

  it('does not include issues or details fields', () => {
    const err = new Error('oops');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN) as Record<string, unknown>;
    assert.equal('issues' in result, false);
    assert.equal('details' in result, false);
  });
});
```

Also add `Problem` to the existing import at the top of `errors.test.ts`:

```typescript
import {
  classifyError,
  createDetailedError,
  getSuggestion,
  isAbortError,
  isNodeError,
  isTimeoutLikeError,
  McpError,
  Problem,
  type Problem as ProblemType,
  zodErrorToProblem,
} from '../../src/core/errors.js';
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
node --test --import tsx/esm "__tests__/unit/errors.test.ts"
```

Expected: FAIL — `Problem.fromUnknown is not a function` or similar.

- [ ] **Step 3: Add `Problem.fromUnknown` to `src/core/errors.ts`**

Locate the `Problem` const object (around line 56). Add `fromUnknown` as the last method before `} as const`:

```typescript
export const Problem = {
  notFound: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.NOT_FOUND, msg, o),
  invalidInput: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.INVALID_INPUT, msg, o),
  accessDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.ACCESS_DENIED, msg, o),
  permissionDenied: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.PERMISSION_DENIED, msg, o),
  timeout: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.TIMEOUT, msg, o),
  cancelled: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.CANCELLED, msg, o),
  tooLarge: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.TOO_LARGE, msg, o),
  ioError: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.IO_ERROR, msg, o),
  validationFailed: (msg: string, o?: ProblemFactoryOptions): Problem =>
    build(ErrorCode.VALIDATION_FAILED, msg, o),
  unknown: (msg: string, o?: ProblemFactoryOptions): Problem => build(ErrorCode.UNKNOWN, msg, o),

  fromUnknown(
    error: unknown,
    defaultCode: ErrorCode,
    path?: string,
  ): { code: ErrorCode; message: string; path?: string; suggestion?: string } {
    const detailed = createDetailedError(error, path);
    const shouldOverride =
      detailed.code === ErrorCode.UNKNOWN || detailed.code === ErrorCode.IO_ERROR;
    const code = shouldOverride ? defaultCode : detailed.code;
    const defaultSuggestion = shouldOverride ? getSuggestion(code) : undefined;
    const suggestion = defaultSuggestion ?? detailed.suggestion;
    return {
      code,
      message: detailed.message,
      ...(detailed.path !== undefined ? { path: detailed.path } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    };
  },
} as const;
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/errors.test.ts"
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/errors.ts __tests__/unit/errors.test.ts
git commit -m "feat(errors): add Problem.fromUnknown for per-item error normalisation"
```

---

## Task 2 — Redefine `RunResult<T>` and update `define.ts` unwrap logic

**Files:**

- Modify: `src/tools/define.ts`
- Modify: `src/tools/_helpers.ts` (transitional shims only — full deletion comes in Task 6)
- Test: `__tests__/unit/define-tool.test.ts`

### Background

`RunResult<T>` currently is `T | { _kind: 'wrapped', content, structuredContent }`. We replace it with `{ structured: T; text?: string; resources?: ContentBlock[] }`. To avoid a big-bang change, we first update `buildToolResponse` / `buildResourceResponse` in `_helpers.ts` to return the new shape — tools can continue to call these helpers and still compile. Then we update `define.ts` to consume the new shape. Tool-by-tool migration happens in Task 4; deletion happens in Task 6.

- [ ] **Step 1: Write a failing test for the new RunResult shape in `__tests__/unit/define-tool.test.ts`**

Add this test after the existing tests:

```typescript
test('defineTool: RunResult with text and resources flows through to CallToolResult', async (): Promise<void> => {
  const resourceLink = {
    type: 'resource_link' as const,
    uri: 'filesystem-mcp://result/abc',
    name: 'file.ts',
    mimeType: 'text/plain',
    size: 10,
  };
  const tool = defineTool({
    ...BASE_DEF,
    run: async () => ({
      structured: { ok: true as const, result: 'new-shape' },
      text: 'summary: file.ts',
      resources: [resourceLink],
    }),
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler);
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.equal((result.structuredContent as TestOutput).result, 'new-shape');
  assert.equal(result.content[0]?.type, 'text');
  assert.equal((result.content[0] as { type: string; text: string }).text, 'summary: file.ts');
  assert.equal(result.content[1], resourceLink);
});

test('defineTool: RunResult without text falls back to JSON.stringify(structured)', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    run: async () => ({
      structured: { ok: true as const, result: 'json-fallback' },
    }),
  });
  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));
  assert.ok(capture.handler);
  const result = await capture.handler({ message: 'test' }, {
    mcpReq: fakeMcpReq(),
  } as unknown as ServerContext);
  assert.equal((result.structuredContent as TestOutput).result, 'json-fallback');
  const text = (result.content[0] as { type: string; text: string }).text;
  assert.equal(text, JSON.stringify({ ok: true, result: 'json-fallback' }));
});
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"
```

Expected: the two new tests FAIL (existing tests pass because tools still return the old shape via `buildToolResponse`).

- [ ] **Step 3: Redefine `RunResult<T>` in `src/tools/define.ts`**

Replace lines 63–65:

```typescript
// BEFORE
export type RunResult<T> =
  | T
  | { readonly _kind: 'wrapped'; content: ContentBlock[]; structuredContent: T };
```

With:

```typescript
export interface RunResult<T> {
  readonly structured: T;
  readonly text?: string;
  readonly resources?: ContentBlock[];
}
```

- [ ] **Step 4: Update the unwrap logic in `define.ts` `coreHandler`**

Replace the try-block inside `coreHandler` (the inner try that calls `def.run`, roughly lines 187–228) with:

```typescript
try {
  const result = await def.run(parsedArgs, toolCtx);
  progressSession.complete(label);
  outcome = signal.aborted ? 'cancelled' : 'success';

  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];

  try {
    resultSizeBytes = Buffer.byteLength(JSON.stringify(result.structured), 'utf8');
  } catch {
    // Ignore serialization error
  }

  return {
    content,
    structuredContent: result.structured as Record<string, unknown>,
  };
} catch (error: unknown) {
  progressSession.fail(error, label);
  outcome = signal.aborted ? 'cancelled' : 'error';
  if (error instanceof Error) {
    errorType = error.name;
    errorMessage = error.message;
  } else {
    errorType = 'UnknownError';
    errorMessage = String(error);
  }
  return buildToolErrorResponse(error, def.defaultErrorCode ?? ErrorCode.UNKNOWN);
}
```

Note: `buildToolErrorResponse` is still imported from `_helpers.ts` here — it gets inlined in Task 3.

- [ ] **Step 5: Update `buildToolResponse` in `src/tools/_helpers.ts` to return `RunResult<T>` shape**

Replace the `buildToolResponse` function (lines 147–161) with:

```typescript
export function buildToolResponse<T>(
  text: string,
  structuredContent: T,
  extraContent: ContentBlock[] = [],
): { structured: T; text: string; resources?: ContentBlock[] } {
  return {
    structured: structuredContent,
    text,
    ...(extraContent.length > 0 ? { resources: extraContent } : {}),
  };
}
```

- [ ] **Step 6: Update `buildResourceResponse` in `src/tools/_helpers.ts` to return `RunResult<T>` shape**

Replace the `buildResourceResponse` function and its `BuildResourceResponseParams` interface (lines 163–179) with:

```typescript
interface BuildResourceResponseParams<T> {
  summary: string;
  resources: ContentBlock[];
  structured: T;
}

export function buildResourceResponse<T>(params: BuildResourceResponseParams<T>): {
  structured: T;
  text: string;
  resources: ContentBlock[];
} {
  return {
    structured: params.structured,
    text: params.summary,
    resources: params.resources,
  };
}
```

- [ ] **Step 7: Run the tests to confirm new tests pass and nothing regressed**

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"
```

Expected: ALL tests PASS (including the two new ones).

- [ ] **Step 8: Run the type checker**

```bash
node scripts/tasks.mjs check --quick
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/tools/define.ts src/tools/_helpers.ts __tests__/unit/define-tool.test.ts
git commit -m "refactor(define): replace _kind sentinel with RunResult<T> {structured,text?,resources?}"
```

---

## Task 3 — Inline `buildToolErrorResponse` into `define.ts`

**Files:**

- Modify: `src/tools/define.ts`
- Modify: `src/tools/_helpers.ts`

### Background

`buildToolErrorResponse` has exactly one caller: the catch block in `coreHandler`. Inlining it removes the only cross-file dependency that `define.ts` has on `_helpers.ts` for error formatting.

- [ ] **Step 1: Add the missing imports to `src/tools/define.ts`**

The inline needs `createDetailedError`, `formatDetailedError`, and `getSuggestion`. These are not currently imported. Update the import from `../core/errors.js`:

```typescript
// BEFORE
import { ErrorCode } from '../core/errors.js';

// AFTER
import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
} from '../core/errors.js';
```

- [ ] **Step 2: Replace the `return buildToolErrorResponse(...)` call with inlined logic**

In the catch block inside `coreHandler`, replace:

```typescript
return buildToolErrorResponse(error, def.defaultErrorCode ?? ErrorCode.UNKNOWN);
```

With:

```typescript
const defaultCode = def.defaultErrorCode ?? ErrorCode.UNKNOWN;
const detailed = createDetailedError(error);
const resolvedCode =
  detailed.code === ErrorCode.UNKNOWN || detailed.code === ErrorCode.IO_ERROR
    ? defaultCode
    : detailed.code;
const defaultSuggestion = resolvedCode !== detailed.code ? getSuggestion(resolvedCode) : undefined;
const errorText = formatDetailedError({
  ...detailed,
  code: resolvedCode,
  ...(defaultSuggestion !== undefined ? { suggestion: defaultSuggestion } : {}),
});
return {
  content: [{ type: 'text' as const, text: errorText }],
  isError: true as const,
  errorCode: resolvedCode,
};
```

- [ ] **Step 3: Remove `buildToolErrorResponse` from the `define.ts` import**

```typescript
// BEFORE
import { buildToolErrorResponse, toToolContext } from './_helpers.js';
import type { ToolContext } from './_helpers.js';

// AFTER
import { toToolContext } from './_helpers.js';
import type { ToolContext } from './_helpers.js';
```

- [ ] **Step 4: Run tests**

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/define.ts src/tools/_helpers.ts
git commit -m "refactor(define): inline buildToolErrorResponse, remove single-callsite helper"
```

---

## Task 4a — Migrate tools without per-item errors

**Files:** `src/tools/calculate-hash.ts`, `src/tools/list.ts`, `src/tools/roots.ts`, `src/tools/search-content.ts`, `src/tools/search-files.ts`

### What to do for each tool

Replace each `buildToolResponse(text, structured)` call with `{ structured, text }` and each `buildResourceResponse({ summary, resources, structured })` call with `{ structured, text: summary, resources }`. Update the import line at the top of each file to remove `buildToolResponse` / `buildResourceResponse` from the `_helpers.js` import.

- [ ] **Step 1: Update `src/tools/calculate-hash.ts`**

Remove `buildResourceResponse` from the import:

```typescript
// BEFORE
import { buildResourceResponse, putResource } from './_helpers.js';

// AFTER
import { putResource } from './_helpers.js';
```

Find the `buildResourceResponse({...})` call (around line 280) and the function signature returning `ReturnType<typeof buildResourceResponse<...>>` (around line 228). Update the return type and the call:

```typescript
// Function signature — update return type
async function buildHashResult(
  // ... params unchanged ...
): Promise<{
  structured: z.infer<typeof HashOutputSchema>;
  text: string;
  resources: ContentBlock[];
}> {

// Call site (around line 280) — replace
// BEFORE:
  return buildResourceResponse({
    summary: summaryText,
    resources: [link],
    structured,
  });

// AFTER:
  return { structured, text: summaryText, resources: [link] };
```

- [ ] **Step 2: Update `src/tools/list.ts`**

```typescript
// BEFORE
import { buildToolResponse, putResource } from './_helpers.js';

// AFTER
import { putResource } from './_helpers.js';
```

Find the `buildToolResponse(label, output)` call (around line 341):

```typescript
// BEFORE
return buildToolResponse(label, output);

// AFTER
return { structured: output, text: label };
```

- [ ] **Step 3: Update `src/tools/roots.ts`**

```typescript
// BEFORE
import { buildToolResponse } from './_helpers.js';

// AFTER (remove that import entirely — no other _helpers imports)
```

Find the `buildToolResponse(summary, structured)` call (around line 31):

```typescript
// BEFORE
return Promise.resolve(buildToolResponse(summary, structured));

// AFTER
return Promise.resolve({ structured, text: summary });
```

- [ ] **Step 4: Update `src/tools/search-content.ts`**

```typescript
// BEFORE (in import from _helpers.js)
  buildResourceResponse,
  buildToolResponse,

// AFTER — remove both lines from the import
```

There are two call sites (around lines 1626 and 1632). Replace each:

```typescript
// Pattern for both call sites:
// BEFORE:
return buildResourceResponse({
  summary,
  resources: [link],
  structured,
});
// ...and:
return buildToolResponse(summary, structured);

// AFTER (respectively):
return { structured, text: summary, resources: [link] };
// ...and:
return { structured, text: summary };
```

- [ ] **Step 5: Update `src/tools/search-files.ts`**

```typescript
// BEFORE (in import)
  buildResourceResponse,
  buildToolResponse,

// AFTER — remove both
```

Two call sites (around lines 670 and 676):

```typescript
// BEFORE:
return buildResourceResponse({
  summary,
  resources: [link],
  structured,
});
return buildToolResponse(summary, structured);

// AFTER:
return { structured, text: summary, resources: [link] };
return { structured, text: summary };
```

- [ ] **Step 6: Type-check**

```bash
node scripts/tasks.mjs check --quick
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/calculate-hash.ts src/tools/list.ts src/tools/roots.ts src/tools/search-content.ts src/tools/search-files.ts
git commit -m "refactor(tools): migrate 5 tools to return RunResult<T> directly"
```

---

## Task 4b — Migrate tools with per-item errors

**Files:** `src/tools/create.ts`, `src/tools/delete-file.ts`, `src/tools/edit.ts`, `src/tools/move.ts`, `src/tools/read.ts`, `src/tools/replace-in-files.ts`, `src/tools/stat.ts`

### What to do for each tool

In addition to the `buildToolResponse`/`buildResourceResponse` changes from Task 4a, each call to `buildStructuredError(err, code, path)` becomes `Problem.fromUnknown(err, code, path)`. Update imports accordingly: add `Problem` from `../core/errors.js`, remove `buildStructuredError` from `_helpers.js`.

- [ ] **Step 1: Update `src/tools/create.ts`**

Update imports:

```typescript
// Remove from _helpers.js import:
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,

// Add to ../core/errors.js import (it already imports ErrorCode):
import { ErrorCode, Problem } from '../core/errors.js';
```

Replace `buildStructuredError` calls (around line 140):

```typescript
// BEFORE:
          error: buildStructuredError(error, ErrorCode.UNKNOWN, file.path),

// AFTER:
          error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, file.path),
```

Replace response calls (around lines 153–160):

```typescript
// BEFORE:
return buildResourceResponse({
  summary,
  resources: [link],
  structured,
});
// ...
return buildToolResponse(summary, structured);

// AFTER:
return { structured, text: summary, resources: [link] };
// ...
return { structured, text: summary };
```

- [ ] **Step 2: Update `src/tools/delete-file.ts`**

```typescript
// Remove from _helpers.js import:
  buildStructuredError,
  buildToolResponse,

// Add Problem to ../core/errors.js import:
import { ErrorCode, Problem } from '../core/errors.js';
```

There are 6 `buildStructuredError` calls (lines 63, 69, 79, 83, 165, 194). Replace each:

```typescript
// BEFORE:
buildStructuredError(error, ErrorCode.NOT_FOUND, path);
buildStructuredError(error, ErrorCode.NOT_DIRECTORY, path);
buildStructuredError(error, ErrorCode.PERMISSION_DENIED, path);
buildStructuredError(error, ErrorCode.UNKNOWN, path);
// etc.

// AFTER (same pattern, just s/buildStructuredError/Problem.fromUnknown/):
Problem.fromUnknown(error, ErrorCode.NOT_FOUND, path);
Problem.fromUnknown(error, ErrorCode.NOT_DIRECTORY, path);
Problem.fromUnknown(error, ErrorCode.PERMISSION_DENIED, path);
Problem.fromUnknown(error, ErrorCode.UNKNOWN, path);
```

Replace the single `buildToolResponse` call (around line 294):

```typescript
// BEFORE:
return buildToolResponse(summary, structured);

// AFTER:
return { structured, text: summary };
```

- [ ] **Step 3: Update `src/tools/edit.ts`**

`edit.ts` imports `RunResult` from `define.ts` and uses it as a return type for `dispatch()`. That import and usage stay — just the shape changes.

```typescript
// Remove from _helpers.js import:
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,

// Add Problem to ../core/errors.js import:
import { ErrorCode, Problem } from '../core/errors.js';
```

Replace `buildStructuredError` (around line 634):

```typescript
// BEFORE:
      error: buildStructuredError(err, ErrorCode.UNKNOWN, filePath),

// AFTER:
      error: Problem.fromUnknown(err, ErrorCode.UNKNOWN, filePath),
```

Replace response calls (around lines 661 and 667):

```typescript
// BEFORE:
return buildResourceResponse({
  summary,
  resources: [link],
  structured,
});
return buildToolResponse(summary, structured);

// AFTER:
return { structured, text: summary, resources: [link] };
return { structured, text: summary };
```

The `dispatch()` return type annotation in edit.ts (`Promise<RunResult<EditOutput>>`) still works because `{ structured, text, resources? }` satisfies the new `RunResult<T>` interface.

- [ ] **Step 4: Update `src/tools/move.ts`**

```typescript
// BEFORE import from _helpers.js:
// AFTER:
// (remove the _helpers.js import entirely if nothing else from it is needed)
// Add Problem to ../core/errors.js import:
import { ErrorCode, Problem } from '../core/errors.js';
import { buildStructuredError, buildToolResponse } from './_helpers.js';
```

Replace `buildStructuredError` (around line 220):

```typescript
// BEFORE:
        const structured = buildStructuredError(err, ErrorCode.UNKNOWN, move.source);

// AFTER:
        const structured = Problem.fromUnknown(err, ErrorCode.UNKNOWN, move.source);
```

Replace `buildToolResponse` (around line 234):

```typescript
// BEFORE:
return buildToolResponse(buildSummary(results, failures), output);

// AFTER:
return { structured: output, text: buildSummary(results, failures) };
```

- [ ] **Step 5: Update `src/tools/read.ts`**

```typescript
// Remove from _helpers.js import:
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,

// Add Problem to ../core/errors.js import:
import { ErrorCode, Problem } from '../core/errors.js';
```

Replace `buildStructuredError` (around line 737):

```typescript
// BEFORE:
  ...(error ? { error: buildStructuredError(error, ErrorCode.UNKNOWN, result.path) } : {}),

// AFTER:
  ...(error ? { error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, result.path) } : {}),
```

Replace `buildResourceResponse` calls (around lines 332–337 and 812–817) and `buildToolResponse` calls (around lines 340 and 818):

```typescript
// BEFORE (single-file with resource):
return buildResourceResponse({
  summary,
  resources: [link],
  structured: structuredWithResource,
});
// BEFORE (single-file without resource):
return buildToolResponse(result.content, structured);

// AFTER:
return { structured: structuredWithResource, text: summary, resources: [link] };
return { structured, text: result.content };

// BEFORE (batch with resources):
return buildResourceResponse({
  summary: summaryText,
  resources: payload.resourceLinks,
  structured,
});
// BEFORE (batch without resources):
return buildToolResponse(summaryText, structured);

// AFTER:
return { structured, text: summaryText, resources: payload.resourceLinks };
return { structured, text: summaryText };
```

Note: the function return type annotations in `handleReadFile` and `handleReadMultipleFiles` reference `ReturnType<typeof buildResourceResponse<ReadFileOutput>>`. Update these to `Promise<{ structured: ReadFileOutput; text: string; resources?: ContentBlock[] }>` or (preferred) remove the explicit return type annotation and let TypeScript infer it.

- [ ] **Step 6: Update `src/tools/replace-in-files.ts`**

```typescript
// Remove from _helpers.js import:
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,

// Add Problem to ../core/errors.js import:
import { ErrorCode, Problem } from '../core/errors.js';
```

Replace `buildStructuredError` calls (around lines 260 and 293):

```typescript
// BEFORE:
      error: buildStructuredError(error, ErrorCode.UNKNOWN, entryPath),
// ...
      error: buildStructuredError(error, ErrorCode.UNKNOWN, validPath),

// AFTER:
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, entryPath),
// ...
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, validPath),
```

Replace response calls (around lines 675 and 681):

```typescript
// BEFORE:
return buildResourceResponse({
  summary: summaryText,
  resources: [link],
  structured,
});
return buildToolResponse(summaryText, structured);

// AFTER:
return { structured, text: summaryText, resources: [link] };
return { structured, text: summaryText };
```

- [ ] **Step 7: Update `src/tools/stat.ts`**

```typescript
// Remove from _helpers.js import:
  buildResourceResponse,
  buildStructuredError,
  buildToolResponse,

// Add Problem to ../core/errors.js import:
import { ErrorCode, Problem } from '../core/errors.js';
```

Replace `buildStructuredError` (around line 281):

```typescript
// BEFORE:
        ? buildStructuredError(entry.error, ErrorCode.NOT_FOUND, entry.path)

// AFTER:
        ? Problem.fromUnknown(entry.error, ErrorCode.NOT_FOUND, entry.path)
```

The function at around line 268 has return type `Promise<StatOutput | ReturnType<typeof buildResourceResponse<StatOutput>>>`. Replace with `Promise<{ structured: StatOutput; text: string; resources?: ContentBlock[] }>` or remove explicit annotation.

Replace response calls (around lines 304 and 372):

```typescript
// BEFORE:
  return buildResourceResponse({
    summary,
    resources: [link],
    structured,
  });
// ...
  return buildToolResponse(`stat: ${parts.join(' • ')}`, { ... });

// AFTER:
  return { structured, text: summary, resources: [link] };
// ...
  return { structured: { ... }, text: `stat: ${parts.join(' • ')}` };
```

- [ ] **Step 8: Type-check all changes**

```bash
node scripts/tasks.mjs check --quick
```

Expected: PASS. If TypeScript complains about a return type annotation that still references `ReturnType<typeof buildResourceResponse<...>>`, remove that explicit annotation — TypeScript can infer the return type.

- [ ] **Step 9: Commit**

```bash
git add src/tools/create.ts src/tools/delete-file.ts src/tools/edit.ts src/tools/move.ts src/tools/read.ts src/tools/replace-in-files.ts src/tools/stat.ts
git commit -m "refactor(tools): migrate 7 tools to RunResult<T> and Problem.fromUnknown"
```

---

## Task 5 — Update tests before dead-code deletion

**Files:**

- Modify: `__tests__/unit/define-tool.test.ts`
- Modify: `__tests__/unit/shared-resource-response.test.ts`

After Task 4, no tool calls `buildToolResponse` or `buildResourceResponse`. Before deleting them in Task 6, we need to update the two test files that still import/test them.

- [ ] **Step 1: Update `__tests__/unit/define-tool.test.ts`**

Remove the `buildToolResponse` import at the top:

```typescript
// BEFORE
import { buildToolResponse } from '../../src/tools/_helpers.js';

// AFTER — delete that line entirely
```

Update `BASE_DEF.run` (line 75) to use the new shape:

```typescript
// BEFORE
  run: async () => buildToolResponse<TestOutput>('test', { ok: true, result: 'success' }),

// AFTER
  run: async () => ({ structured: { ok: true as const, result: 'success' }, text: 'test' }),
```

Update every other `run: async () => buildToolResponse<TestOutput>(...)` in the file (search for all occurrences):

```typescript
// Pattern: any buildToolResponse<TestOutput>('test', { ok: true, result: 'success' })
// Replace with: { structured: { ok: true as const, result: 'success' }, text: 'test' }
```

Affected lines (approximately): 107, 135, 215, 237. All follow the same pattern.

- [ ] **Step 2: Run `define-tool.test.ts` to confirm all pass**

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"
```

Expected: PASS.

- [ ] **Step 3: Update `__tests__/unit/shared-resource-response.test.ts`**

Delete the first test (lines 7–23) which asserts on `buildResourceResponse`:

```typescript
// DELETE this entire test:
test('buildResourceResponse: summary + resource_link blocks + structured', () => {
  // ...
});
```

Leave the `putResource` tests intact — they test `putResource` which stays in `_helpers.ts`.

The file should now import only what it needs:

```typescript
// BEFORE
import { buildResourceResponse, putResource } from '../../src/tools/_helpers.js';

// AFTER
import { putResource } from '../../src/tools/_helpers.js';
```

- [ ] **Step 4: Run the test file to confirm it passes**

```bash
node --test --import tsx/esm "__tests__/unit/shared-resource-response.test.ts"
```

Expected: 2 remaining tests PASS.

- [ ] **Step 5: Commit**

```bash
git add __tests__/unit/define-tool.test.ts __tests__/unit/shared-resource-response.test.ts
git commit -m "test: update fixtures to use RunResult<T> shape, remove buildResourceResponse test"
```

---

## Task 6 — Delete dead exports from `src/tools/_helpers.ts`

**Files:**

- Modify: `src/tools/_helpers.ts`

No callers remain for: `resolveDetailedError`, `buildStructuredError`, `buildToolErrorResponse`, `buildToolResponse`, `buildResourceResponse`, `requireSignal`, `requireLog`, `requireSendNotification`, `requireElicitInput`. Delete them all.

- [ ] **Step 1: Delete `resolveDetailedError` (private helper, lines 73–93)**

Delete the entire function:

```typescript
// DELETE:
function resolveDetailedError(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string,
): { ... } {
  // ...
}
```

- [ ] **Step 2: Delete `buildStructuredError` (lines 95–112)**

```typescript
// DELETE:
export function buildStructuredError(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string,
): { ... } {
  // ...
}
```

- [ ] **Step 3: Delete `buildToolErrorResponse` (lines 114–130)**

```typescript
// DELETE:
export function buildToolErrorResponse(
  error: unknown,
  defaultCode: ErrorCode,
  path?: string,
): { ... } {
  // ...
}
```

- [ ] **Step 4: Delete `buildToolResponse` (the transitional shim)**

```typescript
// DELETE:
export function buildToolResponse<T>(...): ... {
  // ...
}
```

- [ ] **Step 5: Delete `buildResourceResponse` and its `BuildResourceResponseParams` interface**

```typescript
// DELETE:
interface BuildResourceResponseParams<T> { ... }
export function buildResourceResponse<T>(...): ... { ... }
```

- [ ] **Step 6: Delete the four `require*` assertion functions (lines 428–458)**

```typescript
// DELETE all four:
export function requireSignal(...) { ... }
export function requireLog(...) { ... }
export function requireSendNotification(...) { ... }
export function requireElicitInput(...) { ... }
```

- [ ] **Step 7: Remove now-unused imports from `_helpers.ts`**

After the deletions, check the import block at the top. Remove any imports that are only used by the deleted functions:

- `createDetailedError`, `formatDetailedError`, `getSuggestion` from `../core/errors.js` — these were only used by the deleted functions. Remove them. Keep `ErrorCode` and `McpError` (still used by cursor helpers).

```typescript
// BEFORE (from ../core/errors.js):
import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
  McpError,
} from '../core/errors.js';

// AFTER:
import { ErrorCode, McpError } from '../core/errors.js';
```

- [ ] **Step 8: Run type-check**

```bash
node scripts/tasks.mjs check --quick
```

Expected: PASS. If knip complains about unused `ToolResponse<T>` or `ToolErrorResponse` — don't delete them. They are still referenced by `ToolResult<T>` which is exported and used by `tasks.ts` and tests.

- [ ] **Step 9: Commit**

```bash
git add src/tools/_helpers.ts
git commit -m "refactor(_helpers): delete wrap/error/assertion dead exports"
```

---

## Task 7 — Full check and final commit

- [ ] **Step 1: Run the full dev-loop check**

```bash
node scripts/tasks.mjs check
```

Expected: format → lint → type-check → knip → test → rebuild all PASS.

If knip flags `ToolResponse` or `ToolErrorResponse` as unused exports:

- Check that `task-support.test.ts` still imports `ToolResult` from `_helpers.ts`.
- If knip is wrong (they are used via `ToolResult<T>`), add a knip ignore comment or accept the warning. Do NOT delete `ToolResult<T>` — it is used by `tasks.ts`.

If any test fails, refer to `node scripts/tasks.mjs detail <n>` for the source window of the Nth failure.

- [ ] **Step 2: Verify the smoke-test suite still passes (optional but recommended)**

If the MCP Inspector CLI smoke-test skill is available:

```
/filesystem-mcp-smoke-test
```

- [ ] **Step 3: If all green, push or open a PR**

The branch is ready for review.

---

## Self-Review

**Spec coverage check:**

- ✅ `RunResult<T>` new shape — Task 2
- ✅ `define.ts` unwrap → simple text/resources path — Task 2
- ✅ `buildStructuredError` → `Problem.fromUnknown` in `core/errors.ts` — Tasks 1 + 4b
- ✅ `buildToolErrorResponse` inlined, deleted from `_helpers.ts` — Task 3 + 6
- ✅ `buildToolResponse` / `buildResourceResponse` deleted — Tasks 2 (shim) + 4 (migrate) + 6 (delete)
- ✅ `require*` dead exports deleted — Task 6
- ✅ Tests updated — Task 5

**Placeholder scan:** No TBDs, no "add appropriate handling" — all code is shown explicitly.

**Type consistency:** `Problem.fromUnknown` return type in Task 1 matches what Task 4b callers store in `failures[].error` which is typed as `z.infer<typeof PerFileErrorSchema>` = `{ code: string; message: string; path?: string; suggestion?: string }`. `ErrorCode` extends `string` → compatible. ✅
