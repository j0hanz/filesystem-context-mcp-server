# Schema & Tooling Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the new schema-first core foundation, single-file schema layer, and flat tool definition engine (`defineTool`), replacing the legacy 5-layer pipeline.

**Architecture:**

1. The `src/lib/` folder is renamed and consolidated into `src/core/` by grouping by responsibility.
2. A centralized `src/schema.ts` implements all primitives using Zod v4 `$defs` and discriminated unions.
3. `src/tools/define.ts` introduces the `defineTool()` function which handles the entire registration and diagnostic wrapping pipeline.

**Tech Stack:** TypeScript, Node.js, Zod v4, `@modelcontextprotocol/server`

> **Note on Scope Check:** The design spec (2026-05-09) covers the full vertical slice of 16 tools. Following the `writing-plans` guidelines, this plan covers **Phase 1: Core Foundation, Schema, and DefineTool Engine**. The individual tools (Read, Write, Search, Edit) and Server consolidation will be executed via separate follow-up plans once this foundation is committed and type-checked, preventing the scope from becoming unwieldy.

---

## Task 1: Core Foundation Directory Creation (`src/core/`)

**Files:**

- Create: `src/core/`
- Delete: `src/lib/`

- [ ] **Step 1: Write the failing test**

Run: `npx tsc --noEmit`
Expected: PASS (current codebase is valid)

- [ ] **Step 2: Move files and create structure**

Run the following commands in powershell to create the core structure:

```powershell
mkdir src/core -Force
Move-Item src/lib/errors.ts src/core/errors.ts
Move-Item src/lib/resource-store.ts src/core/store.ts
Move-Item src/lib/path-guard.ts src/core/path-guard.ts
Move-Item src/lib/path-completer.ts src/core/path-completer.ts
Move-Item src/lib/zod-codecs.ts src/core/zod-codecs.ts
Move-Item src/lib/file-content.ts src/core/file-content.ts
Move-Item src/lib/atomic-write.ts src/core/atomic-write.ts
Move-Item src/lib/fs-walk.ts src/core/fs-walk.ts
Move-Item src/lib/mime.ts src/core/mime.ts
Move-Item src/lib/parallel.ts src/core/parallel.ts
Move-Item src/lib/worker-pool.ts src/core/worker-pool.ts
Move-Item src/lib/worker.ts src/core/worker.ts
Move-Item src/lib/abort.ts src/core/abort.ts
Move-Item src/lib/logger.ts src/core/logger.ts
Move-Item src/lib/observability.ts src/core/observability.ts
Move-Item src/lib/progress-session.ts src/core/progress-session.ts
Move-Item src/lib/utils.ts src/core/utils.ts
Move-Item src/lib/constants.ts src/core/constants.ts
Remove-Item src/lib -Recurse -Force
```

- [ ] **Step 3: Update global imports**

Run the following to update all imports across the repository from `lib/` to `core/`:

```powershell
Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace "'\.\./lib/", "'../core/" -replace "'\.\./\.\./lib/", "'../../core/" -replace "'\.\./\.\./\.\./lib/", "'../../../core/" -replace "'\./lib/", "'./core/"
    if ($content -ne $newContent) { Set-Content -Path $_.FullName -Value $newContent -NoNewline }
}
```

- [ ] **Step 4: Verify type safety**

Run: `npx tsc --noEmit`
Expected: PASS (if minor import errors remain, fix them before committing)

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "refactor: rename lib to core"
```

## Task 2: Merge Core Foundation Files

**Files:**

- Modify: `src/core/*`

- [ ] **Step 1: Write the failing test**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Merge path-related files**

```powershell
Add-Content src/core/path.ts (Get-Content src/core/path-guard.ts, src/core/path-completer.ts, src/core/zod-codecs.ts -Raw)
Remove-Item src/core/path-guard.ts, src/core/path-completer.ts, src/core/zod-codecs.ts
Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace "from '(?:\.\./)*core/(?:path-guard|path-completer|zod-codecs)\.js'", "from '`$1core/path.js'" -replace "from '\./(?:path-guard|path-completer|zod-codecs)\.js'", "from './path.js'"
    if ($content -ne $newContent) { Set-Content -Path $_.FullName -Value $newContent -NoNewline }
}
```

- [ ] **Step 3: Merge fs-related files**

```powershell
Add-Content src/core/fs.ts (Get-Content src/core/file-content.ts, src/core/atomic-write.ts, src/core/fs-walk.ts, src/core/mime.ts -Raw)
Remove-Item src/core/file-content.ts, src/core/atomic-write.ts, src/core/fs-walk.ts, src/core/mime.ts
Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace "from '(?:\.\./)*core/(?:file-content|atomic-write|fs-walk|mime)\.js'", "from '`$1core/fs.js'" -replace "from '\./(?:file-content|atomic-write|fs-walk|mime)\.js'", "from './fs.js'"
    if ($content -ne $newContent) { Set-Content -Path $_.FullName -Value $newContent -NoNewline }
}
```

- [ ] **Step 4: Merge concurrency files**

```powershell
Add-Content src/core/concurrency.ts (Get-Content src/core/parallel.ts, src/core/worker-pool.ts, src/core/worker.ts, src/core/abort.ts -Raw)
Remove-Item src/core/parallel.ts, src/core/worker-pool.ts, src/core/worker.ts, src/core/abort.ts
Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace "from '(?:\.\./)*core/(?:parallel|worker-pool|worker|abort)\.js'", "from '`$1core/concurrency.js'" -replace "from '\./(?:parallel|worker-pool|worker|abort)\.js'", "from './concurrency.js'"
    if ($content -ne $newContent) { Set-Content -Path $_.FullName -Value $newContent -NoNewline }
}
```

- [ ] **Step 5: Merge observability files**

```powershell
Add-Content src/core/observability-new.ts (Get-Content src/core/logger.ts, src/core/observability.ts, src/core/progress-session.ts -Raw)
Remove-Item src/core/logger.ts, src/core/observability.ts, src/core/progress-session.ts
Rename-Item src/core/observability-new.ts src/core/observability.ts
Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace "from '(?:\.\./)*core/(?:logger|progress-session)\.js'", "from '`$1core/observability.js'" -replace "from '\./(?:logger|progress-session)\.js'", "from './observability.js'"
    if ($content -ne $newContent) { Set-Content -Path $_.FullName -Value $newContent -NoNewline }
}
```

- [ ] **Step 6: Merge utility files**

```powershell
Add-Content src/core/util.ts (Get-Content src/core/utils.ts, src/core/constants.ts -Raw)
Remove-Item src/core/utils.ts, src/core/constants.ts
Get-ChildItem -Path src, __tests__ -Recurse -Filter *.ts | ForEach-Object {
    $content = Get-Content $_.FullName -Raw
    $newContent = $content -replace "from '(?:\.\./)*core/(?:utils|constants)\.js'", "from '`$1core/util.js'" -replace "from '\./(?:utils|constants)\.js'", "from './util.js'"
    if ($content -ne $newContent) { Set-Content -Path $_.FullName -Value $newContent -NoNewline }
}
```

- [ ] **Step 7: Fix internal imports & Run test to verify it passes**

Run the executing agent's editor to quickly open `src/core/path.ts`, `src/core/fs.ts`, `src/core/concurrency.ts`, `src/core/observability.ts`, `src/core/util.ts` to delete internal duplicate imports now that they exist in one file.
Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: Commit**

```powershell
git add .
git commit -m "refactor: consolidate core files per design spec"
```

## Task 3: Schema Layer (`src/schema.ts`)

**Files:**

- Create: `src/schema.ts`
- Create: `__tests__/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/schema.test.ts
import assert from 'node:assert';
import test from 'node:test';

import { z } from 'zod/v4';

import { batchResult, paginated, toMcpSchema } from '../src/schema.js';

test('toMcpSchema generates valid standard schema', () => {
  const schema = z.strictObject({ foo: z.string() }).meta({ id: 'TestSchema' });
  const mcp = toMcpSchema(schema);
  assert.ok(mcp.jsonSchema.input);
  const json = mcp.jsonSchema.input() as Record<string, unknown>;
  assert.equal(json.type, 'object');
  assert.ok(json.$defs);
});

test('batchResult creates correct discriminated union', () => {
  const schema = batchResult(z.string());
  assert.equal(schema._def.discriminator, 'ok');
});

test('paginated creates correct discriminated union', () => {
  const schema = paginated(z.string());
  assert.equal(schema._def.discriminator, 'hasMore');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test __tests__/schema.test.ts`
Expected: FAIL with "Cannot find module '../src/schema.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/schema.ts
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

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

export const IsoDateTime = z.iso.datetime().meta({ id: 'IsoDateTime' });
export const Sha256Hex = z.hash('sha256').meta({ id: 'Sha256Hex' });
export const NonNegInt = z.int().min(0).meta({ id: 'NonNegInt' });
export const PositiveInt = z.int().min(1).meta({ id: 'PositiveInt' });
export const Uint32 = z.uint32().meta({ id: 'Uint32' });
export const FileType = z.enum(['file', 'directory', 'symlink', 'other']).meta({ id: 'FileType' });
export const Path = z.string().min(1).max(4096).meta({ id: 'Path' });
export const Paths = z.array(Path).min(1).max(1000).meta({ id: 'Paths' });
export const Glob = z.string().min(1).max(1000).meta({ id: 'Glob' });
export const CursorOpaque = z.base64url().optional().meta({ id: 'Cursor' });

export const FileInfo = z
  .strictObject({
    name: z.string(),
    path: Path,
    type: FileType,
    size: NonNegInt,
    created: IsoDateTime.optional(),
    modified: IsoDateTime.optional(),
    accessed: IsoDateTime.optional(),
    mimeType: z.string().optional(),
    symlinkTarget: z.string().optional(),
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test __tests__/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/schema.ts __tests__/schema.test.ts
git commit -m "feat: implement centralized schema layer"
```

## Task 4: Tool Definition Engine (`src/tools/define.ts`)

**Files:**

- Create: `src/tools/define.ts`
- Create: `__tests__/unit/define.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// __tests__/unit/define.test.ts
import assert from 'node:assert';
import test from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/core/errors.js';
import { ALL_TOOLS, defineTool } from '../../src/tools/define.js';

test('defineTool creates DefinedTool properly', () => {
  const tool = defineTool({
    name: 'test_tool',
    title: 'Test Tool',
    description: 'A tool',
    input: z.strictObject({ a: z.string() }),
    output: z.strictObject({ b: z.string() }),
    annotations: 'readOnly',
    run: async () => ({ b: 'ok' }),
  });

  assert.equal(tool.name, 'test_tool');
  assert.equal(tool.title, 'Test Tool');
  assert.ok(tool.inputJsonSchema);
  assert.ok(tool.outputJsonSchema);
  assert.equal(tool.annotations, 'readOnly');
  assert.ok(ALL_TOOLS.includes(tool));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test __tests__/unit/define.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tools/define.ts
import type { McpServer } from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { composeAbortSignals } from '../core/concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, McpError } from '../core/errors.js';
import type { Logger, ProgressFn } from '../core/observability.js';
import { ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';

export type Annotation = 'readOnly' | 'idempotentWrite' | 'destructiveWrite';
export type TaskMode = 'forbidden' | 'optional' | 'required';

export interface ToolCtx {
  signal: AbortSignal;
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  log: Logger;
  progress: ProgressFn;
}

export interface ToolDeps {
  isInitialized: () => boolean;
  server: McpServer;
  orchestrator?: any; // typed lightly for now to avoid circular typing before server refactor
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  log: Logger;
}

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: Annotation;
  icons?: any[];
  task?: TaskMode;
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
  register(deps: ToolDeps): void;
}

export const ALL_TOOLS: DefinedTool[] = [];

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const inputSchema = toMcpSchema(def.input);
  const outputSchema = toMcpSchema(def.output);
  const taskMode = def.task ?? 'forbidden';

  const tool: DefinedTool = {
    name: def.name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    task: taskMode,
    nuances: def.nuances ?? [],
    gotchas: def.gotchas ?? [],
    inputJsonSchema: inputSchema.jsonSchema.input(),
    outputJsonSchema: outputSchema.jsonSchema.output(),
    register(deps: ToolDeps) {
      const handler = async (args: any, extra: any) => {
        if (!deps.isInitialized()) {
          throw new McpError(ErrorCode.METHOD_NOT_FOUND, 'Server not initialized');
        }

        const signal = composeAbortSignals(
          extra?.signal,
          def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined,
        );

        let progressSession: ProgressSession | undefined;
        if (extra?.onProgress) {
          const label = def.progressLabel ? def.progressLabel(args) : def.name;
          progressSession = new ProgressSession(extra.onProgress, label);
        }

        const ctx: ToolCtx = {
          signal,
          pathGuard: deps.pathGuard,
          resourceStore: deps.resourceStore,
          log: deps.log,
          progress: progressSession ? progressSession.onProgress.bind(progressSession) : () => {},
        };

        try {
          const result = await def.run(args, ctx);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            ...(result ? { structuredContent: result } : {}),
          };
        } catch (error) {
          const code =
            error instanceof McpError ? error.code : (def.defaultErrorCode ?? ErrorCode.UNKNOWN);
          const message =
            error instanceof McpError ? error.message : formatUnknownErrorMessage(error);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
            _meta: { errorCode: code },
          };
        } finally {
          progressSession?.close();
        }
      };

      if (taskMode !== 'forbidden' && deps.orchestrator) {
        deps.server.experimental.tasks.registerToolTask(
          def.name,
          handler,
          def.description,
          inputSchema,
          {
            output: outputSchema,
            annotations: {
              isDestructive: def.annotations === 'destructiveWrite',
              requiresConfirmation: def.annotations !== 'readOnly',
            },
          },
        );
      } else {
        deps.server.registerTool(def.name, def.description, inputSchema, handler);
      }
    },
  };

  ALL_TOOLS.push(tool);
  return tool;
}

export function registerAllTools(deps: ToolDeps) {
  for (const tool of ALL_TOOLS) {
    tool.register(deps);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test __tests__/unit/define.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
git add src/tools/define.ts __tests__/unit/define.test.ts
git commit -m "feat: implement centralized tool definition engine"
```
