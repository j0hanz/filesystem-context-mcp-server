# Error Handling Redesign — Design

**Date:** 2026-05-08
**Status:** Approved (awaiting implementation plan)
**Approach:** Clean slate (no major version bump). Big-bang redesign behind the existing `McpError` facade.

## 1. Problem statement

The current error-handling stack has accumulated five concrete pain points:

1. **Two parallel taxonomies** — Zod's issue codes and our `ErrorCode` string-union — with lossy translation at the boundary. `parseToolArgs` flattens a structured `ZodError` into a multi-line string.
2. **Message-string sniffing** in `classifyError` (`lower.includes('permission denied')`, `'no such file'`, `'is a directory'`, …) makes classification fragile and locale-dependent.
3. **Static suggestions table** keyed only by `ErrorCode` — no per-issue or per-field context. Constraints live on the schema; hints live in a separate map.
4. **Hand-rolled JSON Schema post-processor** (`walk()`, ~80 LOC) reimplements logic Zod 4's `z.toJSONSchema(schema, { override, io, unrepresentable })` now supports natively.
5. **Freeform `details: Record<string, unknown>`** with no structure, threaded through positional `McpError` constructor args.

Three classification bugs are also baked in: `EMFILE`/`ENFILE` map to `TIMEOUT` ("too many open files" is not a timeout); `EBUSY` maps to `PERMISSION_DENIED` ("resource busy" is not a permission denial).

## 2. Constraints

| Constraint                                                                                                                                                         | Source                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The 8 wire `ErrorCode` strings (`NOT_FOUND`, `ACCESS_DENIED`, `INVALID_INPUT`, `CANCELLED`, `PERMISSION_DENIED`, `TIMEOUT`, `TOO_LARGE`, `UNKNOWN`) are **stable** | ~50+ test assertions across `__tests__/security.test.ts`, `__tests__/tools/*.test.ts`, `__tests__/unit/*.test.ts`                           |
| Additions to `ErrorCode` are allowed                                                                                                                               | Test assertions only check exact string match; no exhaustiveness check on the wire side                                                     |
| `McpError` must remain throwable (`extends Error`)                                                                                                                 | Used across `path-guard.ts`, `resource-store.ts`, `move-file.ts`, `replace-in-files.ts`; `try/catch` patterns rely on `instanceof McpError` |
| `__tests__/contract.test.ts` annotations and tool registration shape unchanged                                                                                     | Ouf of scope                                                                                                                                |
| No major version bump                                                                                                                                              | Per user direction                                                                                                                          |

## 3. Architecture

Three layers, no others:

```
┌─────────────────────────────────────────────────────────┐
│  Tool handlers   (throw Problem.notFound(...) etc.)     │
└─────────────────────────────────────────────────────────┘
                          │ throws McpError(problem)
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Classifier      classify(unknown) → Problem            │
│   - errno table (ENOENT → NOT_FOUND, …)                 │
│   - AbortSignal.reason / .name → CANCELLED              │
│   - ZodError → VALIDATION_FAILED + issues[]             │
│   - McpError → passthrough                              │
│   - else → IO_ERROR (no message sniffing)               │
└─────────────────────────────────────────────────────────┘
                          │ Problem
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Serializer      problemToWire(p) → structuredContent   │
│   - Always emits {code, message}                        │
│   - Conditionally emits {path, suggestion, issues,      │
│      details} when present                              │
│   - Text content: pretty-printed for humans             │
└─────────────────────────────────────────────────────────┘
```

The **classifier is pure** (no I/O, no logging) and lives in `src/lib/problem.ts`. The serializer lives in `src/tools/shared.ts`. Diagnostics/log routing observe `McpError` events but never modify `Problem`.

## 4. Data model

### `Problem` — single source of truth

```ts
// src/lib/problem.ts (new)
export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly issues?: ProblemIssue[];
  readonly suggestion?: string;
  readonly details?: ProblemDetails;
}

export interface ProblemIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string; // Zod issue.code OR custom rule (e.g. 'mutually_exclusive')
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ProblemDetails {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
  readonly errno?: string; // 'ENOENT', 'EACCES', …
  readonly syscall?: string; // 'open', 'stat', …
  readonly tool?: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}
```

### `McpError` — thin throwable carrier

```ts
export class McpError extends Error {
  constructor(
    public readonly problem: Problem,
    cause?: unknown
  ) {
    super(problem.message, cause === undefined ? {} : { cause });
    this.name = 'McpError';
  }
  get code(): ErrorCode {
    return this.problem.code;
  }
  get path(): string | undefined {
    return this.problem.path;
  }
  get details(): ProblemDetails | undefined {
    return this.problem.details;
  }
}
```

The pre-existing positional constructor (`new McpError(code, msg, path, details, cause)`) is kept as an **overload** that delegates to the new shape, so call sites in `path-guard.ts`, `resource-store.ts`, `move-file.ts`, and `replace-in-files.ts` keep compiling without per-file edits during the rollout. The overload is _not_ deprecated — it's a forwarding constructor.

### `ErrorCode` — additive

Existing 8 wire-stable codes preserved verbatim. Added:

| Code                | Meaning                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED` | Zod schema rejection. Carries `issues[]`. Distinct from `INVALID_INPUT` (which becomes "input was structurally valid but semantically wrong"). |
| `IO_ERROR`          | Unclassified `NodeJS.ErrnoException`. Replaces the message-sniffing fallback.                                                                  |

Plus three internal codes that were already unused (`NOT_FILE`, `NOT_DIRECTORY`, `INVALID_PATTERN`, `SYMLINK_NOT_ALLOWED`) — no change.

## 5. Classification

```ts
// src/lib/problem.ts
export function classify(
  error: unknown,
  ctx?: { schema?: z.ZodType }
): Problem {
  if (error instanceof McpError) return error.problem;
  if (error instanceof z.ZodError) return zodErrorToProblem(error, ctx?.schema);
  const signal = walkCauseChain(error);
  return buildProblemFromSignal(signal, error);
}
```

`walkCauseChain` returns a discriminated union; **no message sniffing**:

```ts
type ClassificationSignal =
  | { kind: 'abort'; reason?: string }
  | { kind: 'timeout'; errno?: string }
  | { kind: 'errno'; errno: string; syscall?: string; path?: string }
  | { kind: 'unknown' };
```

Detection precedence (terminates on first match while walking `.cause`):

1. **Abort** — `error.name === 'AbortError'` OR `error.code === 'ABORT_ERR'` OR (`error instanceof DOMException && error.name === 'AbortError'`). → `CANCELLED`.
2. **Timeout** — `error.name === 'TimeoutError'` OR errno `ETIMEDOUT`. → `TIMEOUT`.
3. **Errno** — `typeof error.code === 'string'` AND matches `/^E[A-Z]+$/`. Looked up in the errno table. → mapped code.
4. **Unknown** — falls through to `IO_ERROR` for unclassifiable errors-with-cause; truly opaque values (`undefined`, `null`, plain object) become `UNKNOWN`.

### Errno table

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
  EMFILE: ErrorCode.IO_ERROR, // FIX: was TIMEOUT
  ENFILE: ErrorCode.IO_ERROR, // FIX: was TIMEOUT
  EBUSY: ErrorCode.IO_ERROR, // FIX: was PERMISSION_DENIED
  ENOTEMPTY: ErrorCode.NOT_DIRECTORY,
  EEXIST: ErrorCode.INVALID_INPUT,
  EINVAL: ErrorCode.INVALID_INPUT,
};
```

### Deletions

The `osConstants.errno` reverse-lookup machinery (~50 LOC: `ERRNO_CODE_BY_VALUE`, `SYSTEM_ERROR_MAP`, `getSystemErrorNameFromMap`, `getNodeErrorCodeFromErrno`) is removed. Node always populates `error.code` on `ErrnoException`; the numeric-only path is unreached defensive code.

`classifyMessageError`, message-substring matching, and the `NOT_FOUND_PATTERNS`/`PERMISSION_DENIED_PATTERNS` arrays are removed.

### Zod → Problem

```ts
function zodErrorToProblem(err: z.ZodError, schema?: z.ZodType): Problem {
  const issues: ProblemIssue[] = err.issues.map(toProblemIssue);
  return {
    code: ErrorCode.VALIDATION_FAILED,
    message: z.prettifyError(err),
    issues,
    suggestion: resolveSuggestion(
      { code: ErrorCode.VALIDATION_FAILED, issues },
      schema
    ),
  };
}
```

Custom Zod rules (`superRefine`) emit machine-readable `params`:

```ts
ctx.addIssue({
  code: 'custom',
  path: ['head'],
  message: "Cannot use 'head' with 'startLine'/'endLine'",
  params: {
    rule: 'mutually_exclusive',
    conflictsWith: ['startLine', 'endLine'],
    suggestion: 'Use line ranges OR head, not both.',
  },
});
```

Clients can branch on `issue.params.rule` instead of parsing English.

## 6. JSON Schema pipeline

`src/schemas/json-schema.ts` `walk()` recursion is replaced by Zod 4's native `override` callback, which runs per-schema-node during conversion:

```ts
const JSON_SCHEMA_OVERRIDE: z.core.JSONSchemaOverride = (ctx) => {
  const out = ctx.jsonSchema;
  if (out.format === 'date-time' && 'pattern' in out) delete out.pattern;
  if (out.type === 'integer' && out.maximum === Number.MAX_SAFE_INTEGER)
    delete out.maximum;
  if (
    typeof out.format === 'string' &&
    NONSTANDARD_FORMATS.has(out.format) &&
    'pattern' in out
  ) {
    delete out.format;
  }
  if ('contentEncoding' in out && 'pattern' in out) delete out.contentEncoding;
};

export function toToolJsonSchema(zodSchema, augment?) {
  const raw = z.toJSONSchema(zodSchema, {
    io: 'input',
    unrepresentable: 'any',
    override: JSON_SCHEMA_OVERRIDE,
  }) as JsonSchema;
  const cleaned = postProcessRoot(raw); // strips $schema + defaulted-required
  return fromJsonSchema(augment ? augment(cleaned) : cleaned);
}
```

The defaulted-from-required cleanup remains a post-pass because it's a relationship between sibling keys (`required[]` and `properties.<x>.default`) that `override` cannot see in isolation. It walks the schema tree once, non-mutating.

`readRangeConstraints()` and `safeGlobConstraint()` (the `augment` callback contract) are unchanged — they inject `allOf`/`if-then` constructs Zod cannot natively express.

**Net deletion:** ~150 LOC file → ~80 LOC.

## 7. Suggestions: schema-attached with fallback

The static `ERROR_SUGGESTIONS` map becomes the **last** of three sources:

```ts
export function resolveSuggestion(
  p: Pick<Problem, 'code' | 'issues'>,
  schema?: z.ZodType
): string | undefined {
  // 1. Schema metadata: walk schema by issue path → .meta().suggestion
  if (p.issues?.length && schema) {
    for (const issue of p.issues) {
      const fromMeta = suggestionFromIssueMeta(schema, issue);
      if (fromMeta) return fromMeta;
    }
  }
  // 2. Rule params: custom rules carry their own hint
  if (p.issues?.length) {
    for (const issue of p.issues) {
      const fromRule = issue.params?.['suggestion'];
      if (typeof fromRule === 'string') return fromRule;
    }
  }
  // 3. Per-code default
  return DEFAULT_SUGGESTIONS[p.code];
}
```

Schema-attached suggestions live in `.meta()`:

```ts
export const SafeGlobPattern = z
  .string()
  .min(1, 'Pattern required')
  .refine((v) => isSafeGlobSyntax(v), { error: 'Invalid glob or unsafe path' })
  .meta({
    id: 'SafeGlobPattern',
    title: 'Glob Pattern',
    examples: ['**/*.ts', 'src/**/*.js'],
    suggestion:
      'Use forward-slash globs; absolute paths and ".." are forbidden.',
  });
```

`DEFAULT_SUGGESTIONS` mirrors today's table for the existing 8 codes; `VALIDATION_FAILED` and `IO_ERROR` default to `undefined` (issues carry their own).

## 8. Tool-side ergonomics

### Throwing

Old:

```ts
throw new McpError(ErrorCode.NOT_FOUND, 'File not found', path, {
  tool: 'read',
});
```

New (preferred):

```ts
throw Problem.notFound('File not found', { path });
throw Problem.invalidInput('Pattern too short', { path });
throw Problem.from(zodError, { schema: ReadFileInputSchema });
throw Problem.fromNode(nodeError, { path }); // errno-classified
```

`Problem.notFound(...)` etc. construct the `Problem` and wrap in `McpError` so `throw` works.

### Argument validation

```ts
function parseToolArgs<S extends z.ZodType>(
  schema: S,
  args: unknown
): z.infer<S> {
  const result = schema.safeParse(args ?? {});
  if (result.success) return result.data;
  throw new McpError(zodErrorToProblem(result.error, schema));
}
```

Wire output for an invalid arg:

```jsonc
{
  "structuredContent": {
    "error": {
      "code": "VALIDATION_FAILED",
      "message": "✖ Pattern required\n  → at pattern",
      "issues": [
        {
          "path": ["pattern"],
          "code": "too_small",
          "message": "Pattern required",
          "params": { "minimum": 1 },
        },
      ],
      "suggestion": "Use forward-slash globs; absolute paths and \"..\" are forbidden.",
    },
  },
  "content": [
    {
      "type": "text",
      "text": "VALIDATION_FAILED: ✖ Pattern required\n  → at pattern\n\nUse forward-slash globs...",
    },
  ],
  "isError": true,
}
```

`issues[]` is **always included when present** (no opt-in flag). The text block keeps the multi-line `prettifyError` rendering for human consumers; structured `issues[]` is for programmatic clients.

### `defineTool` `defaultErrorCode`

Behavior narrows: `defaultErrorCode` only upgrades errors classified as `IO_ERROR`/`UNKNOWN`. Previously, message-sniffing could promote a generic `Error` to a domain code based on words in its message; now only real `ETIMEDOUT`/`AbortError` produce `TIMEOUT`. Verified: `__tests__/unit/define-tool.test.ts:456` still passes (plain `Error` → `UNKNOWN` → upgraded by `defaultErrorCode: TIMEOUT`).

## 9. Locale seam

Add `z.config(z.locales.en())` once in `src/index.ts` bootstrap. No runtime behavior change today; future per-session locale becomes a one-liner inside HTTP session creation.

## 10. Testing strategy

### Replaced

- **`__tests__/unit/errors.test.ts`** rewritten (~270 LOC out, ~250 LOC in):
  - Construction: each `Problem.*` factory produces correct shape
  - `McpError` carrier: back-compat getters work, `cause` propagates
  - Classification: `classify(unknown) → UNKNOWN`, `classify(McpError)` passthrough, errno table row-by-row
  - **Errno fixes locked in**: `EMFILE`/`ENFILE`/`EBUSY` → `IO_ERROR`
  - Cause chain: `new Error('outer', { cause: enoent })` → `NOT_FOUND`
  - Abort: real `AbortController().abort()` → `CANCELLED`; `DOMException('','AbortError')` → `CANCELLED`
  - **No-sniffing property locked in**: `new Error('permission denied')` → `UNKNOWN`, NOT `PERMISSION_DENIED`

### New

- **`__tests__/unit/problem.test.ts`** (~150 LOC):
  - `zodErrorToProblem` maps each `ZodIssue` correctly (path normalization, expected/received, params passthrough)
  - Custom `superRefine` issue with `params: { rule, conflictsWith, suggestion }` round-trips intact
  - `resolveSuggestion` precedence: schema-meta > rule-params > default
  - Wire serialization: `problemToWire(p)` includes `issues` only when non-empty; omits `details` when empty

### Updated

- `__tests__/unit/define-tool.test.ts`, `__tests__/unit/shared.test.ts` — `ErrorCode.X` constants pass through unchanged
- `__tests__/tools/read-write.test.ts` lines 512, 604, 702, 726 — flip `'INVALID_INPUT'` → `'VALIDATION_FAILED'` (verify each is actually a Zod failure first)
- `__tests__/tools/directory.test.ts` lines 382, 394 — same flip
- `__tests__/schemas/snapshot.test.ts` — expected byte-identical; if drift, update once

### Unchanged

- `__tests__/contract.test.ts`

## 11. Rollout sequence (single PR, ordered commits)

1. **Add new files; old API still works**
   - `src/lib/problem.ts`, `src/lib/error-suggestions.ts`
   - Add `VALIDATION_FAILED`, `IO_ERROR` to `ErrorCode` in `src/config.ts`
   - `__tests__/unit/problem.test.ts`
   - **Gate:** `npm run tasks` passes; existing tests untouched.

2. **Reroute through new pipeline behind `McpError` facade**
   - `McpError` constructor accepts `Problem` OR positional args (overload)
   - Getters read from `.problem`
   - `McpError.notFound` etc. delegate to `Problem.*`
   - Delete `walkErrorChain`, `classifyMessageError`, `getNodeErrorCodeFromErrno`, `ERRNO_CODE_BY_VALUE`, `SYSTEM_ERROR_MAP`
   - **Gate:** existing tests pass (riskiest step — sniffing deletion).

3. **JSON Schema pipeline rewrite**
   - Replace `walk()` with native `override`
   - **Gate:** `__tests__/schemas/snapshot.test.ts` passes.

4. **Validation surface upgrade**
   - `parseToolArgs` throws `VALIDATION_FAILED`
   - `validateReadRange` issues carry `params: { rule, conflictsWith, suggestion }`
   - Flip the ~6 test assertions
   - Add `.meta({ suggestion })` to `SafeGlobPattern` and 2-3 other shared fields
   - **Gate:** all tests pass; manual `npm run inspector` smoke test on one error.

5. **Rewrite `__tests__/unit/errors.test.ts`**
   - **Gate:** `npm run tasks` clean.

6. **Cleanup**
   - Delete obsolete helpers (knip-flagged): `formatDetailedError`, `createDetailedError`, `getSuggestion`, `buildStructuredError` if unused
   - `z.config(z.locales.en())` in `src/index.ts`

## 12. Risks

| Risk                                                                               | Mitigation                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `walk()` replacement subtly changes a JSON Schema field                            | Snapshot test catches; manual diff review of one snapshot before merging |
| `define-tool.test.ts:456` relies on message-sniffing                               | Verified: it doesn't (plain Error → UNKNOWN → default upgrade)           |
| Production code throws `Error('timed out')` and relies on `TIMEOUT` classification | Grep at step 2; convert to `Problem.timeout(...)`                        |
| `path-guard.ts` ~10 throws use 4-arg constructor                                   | Constructor overload keeps them compiling                                |
| `resource-store.ts` 4 throws                                                       | Same                                                                     |
| Errno fixes (`EMFILE`/`EBUSY`) break a downstream consumer                         | No test pins these; documented in PR description                         |

## 13. Out of scope

- Changing the 8 stable wire codes (only additions allowed)
- `McpError` rename or namespace move
- Per-session locale switching (seam added, no runtime change)
- Result-type / functional refactor (Approach B, rejected)
- Any change to `__tests__/contract.test.ts` annotations or tool registration shape

## 14. Acceptance criteria

1. `npm run tasks` passes (lint/type-check/knip/test/build) on Windows + Linux
2. No production code references `classifyMessageError`, `walkErrorChain` (deleted), or `walk()` (deleted)
3. Grep `lower.includes` and `message.includes` in `src/lib/errors.ts` returns zero
4. A Zod validation error response wire-payload contains `issues: [...]` with at least one entry that has `path`, `code`, `message`
5. `EMFILE`/`ENFILE`/`EBUSY` produce `IO_ERROR` (not `TIMEOUT`/`PERMISSION_DENIED`)
6. JSON Schema snapshot is unchanged OR has been reviewed and re-snapshotted exactly once
