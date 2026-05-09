# Schema & Tooling Redesign — Design Spec

- **Date:** 2026-05-09
- **Branch:** `dev`
- **Status:** Approved design; implementation plan pending
- **Scope:** Full vertical slice — schema layer, tool contract, `defineTool`, registration pipeline, output conventions, tool inventory, folder layout
- **Breaking changes:** Allowed and intended

---

## 1. Goal

Replace the current schema + tool-definition stack with a single, schema-first, discriminated-union-based design that:

- Eliminates the `inputSchema` / `inputSchemaJson` dual-world (`as never` casts, hand-crafted `oneOf`/`allOf`).
- Replaces flat "everything optional" output bags with discriminated unions that teach LLM clients the shape.
- Collapses today's 5-layer registration pipeline (`ToolContract` → `defineTool` → `registerStandardTool` → `wrapToolHandler` → `executeToolWithDiagnostics` → `convertSchemasToWire`) into one flat `defineTool()` call.
- Consolidates near-duplicate tools (`read` + `read_many`, `stat` + `stat_many`, etc.) into single `paths: string[]` tools that return `BatchResult<T>` per item, dropping inventory from 18 to 16.
- Uses Zod v4's `$defs` registry so `tools/list` doesn't inline `FileInfo` six times.

## 2. Non-goals

- Re-implementing `PathGuard`, `ResourceStore`, `WorkerPool`, `parallel.ts`, `fs-walk.ts`, `atomic-write.ts`, `file-content.ts`, `mime.ts`. These are sound and stay (with `lib/` → `core/` rename only).
- Changing MCP transport choice, session lifecycle, or task-orchestration semantics.
- Introducing new test/lint/formatter tooling (per `AGENTS.md`).
- Adding new MCP capabilities beyond what's already advertised.

## 3. Architecture overview

### 3.1 Folder layout (hybrid: feature folders for complex tools, single files for simple ones)

```text
src/
├── cli.ts, config.ts, index.ts, server.ts
│
├── core/                         (was lib/)
│   ├── path-guard.ts, errors.ts, abort.ts
│   ├── file-content.ts, atomic-write.ts, fs-walk.ts, mime.ts
│   ├── parallel.ts, worker-pool.ts, worker.ts
│   ├── resource-store.ts, observability.ts, logger.ts
│   ├── progress-session.ts
│   └── constants.ts, utils.ts
│
├── schema/                       (was schemas/)
│   ├── primitives.ts             — registered leaf primitives
│   ├── fs.ts                     — domain composites (FileInfo, BatchResult, Continuation)
│   └── io.ts                     — toMcpSchema() adapter (~40 lines)
│
├── tools/
│   ├── define.ts                 — flat defineTool() + DefinedTool type
│   ├── registry.ts               — ALL_TOOLS array + registerAllTools()
│   ├── presets.ts                — annotation presets + icon sets
│   │
│   ├── read/{schema.ts, handler.ts, index.ts}
│   ├── write/, search-text/, replace-text/, apply-patch/, edit-file/, diff-files/
│   │
│   ├── list-dir.ts, tree.ts, find-files.ts, stat.ts, hash-file.ts
│   ├── make-dir.ts, move.ts, delete.ts, list-roots.ts
│
├── server/
│   ├── index.ts                  — re-export façade
│   ├── bootstrap.ts              — createMcpServer() (transport-agnostic)
│   ├── stdio.ts                  — startStdio()
│   ├── http.ts                   — startHttp() (Express, sessions, host validation, auth guard)
│   ├── roots.ts                  (was roots-manager.ts)
│   ├── tasks.ts                  (was task-orchestrator.ts)
│   ├── task-store.ts, event-store.ts
│
├── prompts/
│   ├── index.ts                  — registerAllPrompts()
│   └── <one file per prompt>
│
└── resources/
    ├── index.ts, instructions.ts, filesystem.ts, result.ts
```

### 3.2 Tool inventory (15 tools, snake_case, verb-first)

| New name       | Replaces                                                       | Notes                                                      |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| `read`         | `read`, `read_many`                                            | `paths: string[]`; range modes: full/head/tail/lines/bytes |
| `write`        | `write_file`                                                   | atomic; modes: create/overwrite/append                     |
| `stat`         | `stat`, `stat_many`, `get_file_info`, `get_multiple_file_info` | `paths: string[]`                                          |
| `list_dir`     | `list_directory`                                               | snapshot-cursor pagination                                 |
| `tree`         | `tree`                                                         | unchanged behavior                                         |
| `find_files`   | `search_files`                                                 | by name/glob; offset cursor                                |
| `search_text`  | `search_content`                                               | grep                                                       |
| `replace_text` | `search_and_replace` / `replace_in_files`                      | regex replace                                              |
| `edit_file`    | `edit_file`                                                    | structural search/replace                                  |
| `apply_patch`  | `apply_patch`                                                  | unified diff                                               |
| `diff_files`   | `diff_files`                                                   | unchanged                                                  |
| `hash_file`    | `calculate_hash`                                               | renamed for verb-first                                     |
| `make_dir`     | `create_directory`                                             |                                                            |
| `move`         | `move_file`                                                    | files + dirs                                               |
| `delete`       | `delete_file`                                                  | files + dirs                                               |
| `list_roots`   | `list_allowed_directories`                                     |                                                            |

## 4. Schema layer

### 4.1 `schema/primitives.ts`

Every reusable leaf is registered once via `.meta({ id })` so Zod v4's `$defs` registry emits `$ref` instead of inlining:

```ts
export const IsoDateTime = z.iso.datetime().meta({ id: 'IsoDateTime' });
export const Sha256Hex = z.hash('sha256').meta({ id: 'Sha256Hex' });
export const NonNegInt = z.int().min(0).meta({ id: 'NonNegInt' });
export const PositiveInt = z.int().min(1).meta({ id: 'PositiveInt' });
export const Uint32 = z.uint32().meta({ id: 'Uint32' });
export const FileType = z.enum(['file', 'directory', 'symlink', 'other']).meta({ id: 'FileType' });
export const Path = z.string().min(1).max(4096).meta({ id: 'Path' });
export const Paths = z.array(Path).min(1).max(1000).meta({ id: 'Paths' });
export const Glob = z.string().min(1).max(1000).refine(isSafeGlobSyntax).meta({ id: 'Glob' });
export const CursorOpaque = z.base64url().optional().meta({ id: 'Cursor' });
```

### 4.2 `schema/fs.ts`

Domain composites — every shared shape is registered. `batchResult<T>` and `paginated<T>` are reusable factories:

```ts
export const FileInfo = z
  .strictObject({
    /* name,path,type,size,...,mimeType?,symlinkTarget? */
  })
  .meta({ id: 'FileInfo' });

export const BatchItemError = z
  .strictObject({
    code: z.string(),
    message: z.string(),
    suggestion: z.string().optional(),
  })
  .meta({ id: 'BatchItemError' });

export const batchResult = <T extends z.ZodType>(payload: T) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), path: Path, data: payload }),
    z.strictObject({ ok: z.literal(false), path: Path, error: BatchItemError }),
  ]);

export const BatchSummary = z
  .strictObject({
    total: NonNegInt,
    succeeded: NonNegInt,
    failed: NonNegInt,
  })
  .meta({ id: 'BatchSummary' });

export const paginated = <T extends z.ZodType>(
  payload: T,
  extraFalse: z.ZodRawShape = {},
  extraTrue: z.ZodRawShape = {},
) =>
  z.discriminatedUnion('hasMore', [
    z.strictObject({ hasMore: z.literal(false), items: z.array(payload), ...extraFalse }),
    z.strictObject({
      hasMore: z.literal(true),
      items: z.array(payload),
      nextCursor: z.string(),
      ...extraTrue,
    }),
  ]);

export const Continuation = z
  .strictObject({
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    hint: z.string(),
  })
  .meta({ id: 'Continuation' });
```

### 4.3 `schema/io.ts`

The entire JSON-Schema adapter. ~40 lines, no `augment` hook (discriminated unions emit `oneOf` natively):

```ts
const STRIP_FORMATS = new Set(['base64url', 'sha256_hex']);

const override: NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override'] = (ctx) => {
  const s = ctx.jsonSchema as Record<string, unknown>;
  if (s.format === 'date-time' && 'pattern' in s) delete s.pattern;
  if (s.type === 'integer' && s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
  if (typeof s.format === 'string' && STRIP_FORMATS.has(s.format) && 'pattern' in s)
    delete s.format;
  if ('contentEncoding' in s && 'pattern' in s) delete s.contentEncoding;
};

export function toMcpSchema(schema: z.ZodType): StandardSchemaWithJSON {
  // io: 'input' makes Zod exclude defaulted fields from `required` — kills the post-pass.
  // reused: 'ref' emits $defs for any schema with .meta({ id }).
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    reused: 'ref',
    override,
  });
  delete (json as Record<string, unknown>).$schema;
  return Object.assign({}, schema['~standard'], {
    jsonSchema: { input: () => json, output: () => json },
  }) as never;
}
```

### 4.4 What dies

- `removeDefaultedFromRequired` post-pass (replaced by `io: 'input'`).
- All `superRefine` blocks for read-range / byte-range mutual exclusion (replaced by `discriminatedUnion('mode', ...)`).
- `inputSchemaJson` field on `ToolContract` and the `augment` hook on `toToolJsonSchema` (no longer needed — Zod emits `oneOf` natively).
- `readRangeConstraints()` and `safeGlobConstraint()` helpers in `json-schema.ts`.
- `createReadRangeFields()` and `validateReadRange()` in `schemas/shared.ts`.

## 5. Tool definition surface (`tools/define.ts`)

### 5.1 Public API

```ts
export type Annotation = 'readOnly' | 'idempotentWrite' | 'destructiveWrite';
export type TaskMode = 'forbidden' | 'optional' | 'required';

export interface ToolCtx {
  signal: AbortSignal;
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  log: Logger;
  progress: ProgressFn;
  elicit?: (params: ElicitFormParams) => Promise<ElicitResult>;
}

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  name: string; // snake_case, verb_target
  title: string;
  description: string;
  input: I;
  output: O; // required for every tool
  annotations: Annotation; // preset string
  icons?: Icon[];
  task?: TaskMode; // default 'forbidden'
  timeoutMs?: number;
  progressLabel?: (args: z.infer<I>) => string;
  defaultErrorCode?: ErrorCode;
  run: (args: z.infer<I>, ctx: ToolCtx) => Promise<z.infer<O>>;
  nuances?: string[];
  gotchas?: string[];
}

export interface DefinedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: Annotation;
  readonly task: TaskMode;
  readonly nuances: readonly string[];
  readonly gotchas: readonly string[];
  readonly inputJsonSchema: object;
  readonly outputJsonSchema: object;
  register(server: McpServer, deps: ToolDeps): void;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool;
```

### 5.2 What `defineTool` does internally

One private function:

1. Convert `input`/`output` once via `toMcpSchema()`. Cache.
2. Resolve `annotations` preset → MCP `ToolAnnotations` object.
3. Build wrapped handler:
   - Guard `deps.isInitialized()`.
   - Compose `AbortSignal` from `ToolContext.signal` + `timeoutMs` via `core/abort.ts`.
   - Open `ProgressSession` with label `progressLabel(args) ?? name`.
   - Wrap the call in `withToolDiagnostics({ name, traceContext })` (extracts `traceparent` from `_meta`).
   - Success → `{ structuredContent, content: [{type:'text', text: JSON.stringify(structured)}] }`.
   - Throw of `McpError` → `{ isError: true, content: [text] }`, `_meta.errorCode`. **No `structuredContent`** (matches SDK `validateToolOutput` skip-condition).
   - Throw of unknown → wrap in `McpError(defaultErrorCode ?? UNKNOWN, formatUnknownErrorMessage(e))`.
4. If `task !== 'forbidden'` and `deps.orchestrator` present → `experimental.tasks.registerToolTask`. Otherwise → `server.registerTool`. **No `as never` casts** because `toMcpSchema` returns the SDK's exact `StandardSchemaWithJSON`.

### 5.3 Things that disappear

| Today                                                                                                                     | Redesign                                                             |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ToolContract` interface                                                                                                  | merged into `ToolDef`                                                |
| `defineTool` factory + `registerStandardTool` + `wrapToolHandler` + `executeToolWithDiagnostics` + `convertSchemasToWire` | one `defineTool()`                                                   |
| `inputSchemaJson` escape hatch                                                                                            | gone                                                                 |
| Two `as never` casts                                                                                                      | gone                                                                 |
| `buildPathMessages` helper                                                                                                | gone (`progressLabel` callback)                                      |
| separate `progressMessage` + `completionMessage` callbacks                                                                | one `progressLabel`; suffix derived from result variant + error code |
| `taskSupport` top-level + duplicated under `execution.taskSupport` + normalization helper                                 | one `task: TaskMode`                                                 |
| `defaultErrorCode` field + `onError` callback                                                                             | only `defaultErrorCode` for un-classified throws                     |
| `outputSchema` optional                                                                                                   | required (so SDK always validates)                                   |
| `maybeStripStructuredContentFromResult` hack                                                                              | gone (errors structurally lack `structuredContent`)                  |

### 5.4 Tool author experience

```ts
// src/tools/read/index.ts
export const READ = defineTool({
  name: 'read',
  title: 'Read Files',
  description: 'Read one or many files. Range modes: full | head | tail | lines | bytes.',
  input: ReadInput,
  output: ReadOutput,
  annotations: 'readOnly',
  icons: READ_FILE_ICONS,
  timeoutMs: 30_000,
  progressLabel: ({ paths }) =>
    paths.length === 1 ? `read: ${basename(paths[0])}` : `read: ${paths.length} files`,
  run: runRead,
  nuances: ['Large content externalized to filesystem-mcp://result/{id} with inline preview.'],
});
```

~15 lines vs. ~120 today. Schema and handler are sibling files in the same folder.

## 6. Output-shape conventions

### 6.1 Discriminated unions everywhere

Every tool's `output` is either a `strictObject` or a `discriminatedUnion`. No bag-of-optionals.

### 6.2 Pagination — `paginated<T>(payload)`

`hasMore: false` ⇒ `items[]` and any totals (`total`, `totalMatches`, etc.).
`hasMore: true` ⇒ `items[]` plus **required** `nextCursor`.

Used by: `list_dir`, `tree`, `find_files`, `search_text`.

### 6.3 Batch — `batchResult<T>` per item

```ts
{ ok: true,  path, data }
| { ok: false, path, error: { code, message, suggestion? } }
```

Top-level shape is `{ results: BatchResult<T>[], summary: { total, succeeded, failed } }`.

Used by: `read`, `stat`, `replace_text`, `apply_patch`, `hash_file`.

Per-item failures **never throw**. The whole call still returns success at the MCP transport level.

### 6.4 Mutually-exclusive option groups — `discriminatedUnion('mode', ...)`

Used by: `read.range` (full/head/tail/lines/bytes), `write.mode` (create/overwrite/append), `find_files.scope` (name/glob).

## 7. Error model

- Handlers **throw** `McpError(code, message, suggestion?, path?)`. Never return `{ isError: true }` manually.
- `defineTool` wrapper maps `McpError` → MCP error response (no `structuredContent`).
- Per-item batch errors are **not thrown** — they appear as `{ ok: false, error }` entries.
- Path-Guard violations already throw `McpError(ErrorCode.PATH_OUTSIDE_ROOTS)` and flow naturally.
- `defaultErrorCode` only kicks in when the handler throws a non-`McpError` value.

## 8. Server bootstrap split

Today's `bootstrap.ts` (~600 LOC, mixes stdio + HTTP/Express + capabilities + logging routing + init timeouts + icons) splits into:

- `server/bootstrap.ts` — `createMcpServer()` builds server, `RootsManager`, deps, registers tools/resources/prompts. Transport-agnostic.
- `server/stdio.ts` — `startStdio(server)`.
- `server/http.ts` — `startHttp(server, opts)`: Express, sessions, host validation, auth guard, init-handshake timeouts.
- `server/index.ts` — public re-export façade so external imports keep working.

Other files (`roots.ts`, `tasks.ts`, `task-store.ts`, `event-store.ts`) are renames only.

## 9. Resources, prompts, instructions

- `resources/instructions.ts`, `tool-info.ts`, `tool-catalog.ts` → pure functions over `ALL_TOOLS: DefinedTool[]`. They read `name/title/description/nuances/gotchas/inputJsonSchema/outputJsonSchema` directly off each `DefinedTool`. **One source of truth** for tool metadata.
- Prompts move from one big `prompts.ts` into `src/prompts/<one-per-prompt>.ts` with `definePrompt({ name, title, args, run })`. Same flat shape as tools.

## 10. Tests

- `__tests__/` layout unchanged.
- `__tests__/schemas/snapshot.test.ts` snapshots regenerated (every output is now `oneOf`/`anyOf`).
- `__tests__/contract.test.ts` updated to assert `DefinedTool` shape.
- `__tests__/tools/refinements.test.ts` shrinks (most cases become structural). Remaining: `endLine >= startLine` stays as `discriminatedUnion + .refine`.
- No new test framework, lint, or formatter introduced.

## 11. What does NOT change

- `PathGuard` API/behavior, `ResourceStore` API, `WorkerPool`, `parallel.ts`, `fs-walk.ts`, `atomic-write.ts`, `file-content.ts`, `mime.ts` (only `lib/` → `core/` import path updates).
- MCP transport choice, session lifecycle, init timeouts, host validation, OAuth guard.
- Task orchestration semantics (cancellation via `EventedTaskStore`, dual-signature handler).
- Logging routing through `node:diagnostics_channel`.

## 12. Migration

- Major version bump in `package.json`.
- `README.md` tool table regenerated from `ALL_TOOLS`.
- `dist-runtime.test.ts` smoke test stays as wire-up canary.
- No backwards-compatible aliases: tool renames are hard. (User explicitly accepted breaking changes.)

## 13. Estimated impact

| Metric                                             | Today      | Redesigned        |
| -------------------------------------------------- | ---------- | ----------------- |
| Tool count                                         | 18         | 15                |
| Schema LOC                                         | ~2400      | ~1200             |
| Tools with `outputSchema`                          | ~70%       | 100%              |
| Layers in registration pipeline                    | 5          | 1                 |
| `as never` casts in tool registration              | 2          | 0                 |
| `inputSchemaJson` escape hatches                   | yes        | gone              |
| `tools/list` payload (FileInfo deduped via `$ref`) | inlined ×6 | one `$defs` entry |
| Per-tool definition LOC (e.g. `read.ts`)           | ~120       | ~30               |

## 14. Open questions

None at design time. Implementation plan will surface concrete sequencing.
