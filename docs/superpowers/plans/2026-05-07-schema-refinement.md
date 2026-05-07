# Schema Refinement & Modernization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split and modernize the schema layer so `tools/list` emits smaller, consistent JSON Schemas — with `$defs` deduplication, no bloated datetime regex, uniform `ok` discriminator, `oneOf` for read modes, and the deprecated singular `source`/`path` inputs removed from `mv`/`mkdir`.

**Architecture:** Create `src/schemas/` directory with primitive builders registered in `z.globalRegistry` (for `$defs`), composite shared shapes, a `json-schema.ts` post-processor that strips the 340-char datetime pattern and `Number.MAX_SAFE_INTEGER` upper bounds, and per-tool `inputs/`/`outputs/` files. Wire a `convertSchemasToWire()` helper into `registerStandardTool` so tool authors never call the converter themselves. The legacy `src/schemas.ts` becomes a thin re-export shim during migration, then is deleted.

**Tech Stack:** TypeScript, Zod v4 (`zod/v4`), `@modelcontextprotocol/server` (`fromJsonSchema`), Node.js `node:test` runner, `tsx/esm` for tests.

---

## File Map

**New files (created across tasks 1–11):**

- `src/schemas/fields.ts` — primitive builders registered in `z.globalRegistry`
- `src/schemas/shared.ts` — composite shapes (FileInfo, Error, etc.)
- `src/schemas/pagination.ts` — cursor/nextCursor primitives
- `src/schemas/json-schema.ts` — `toToolJsonSchema()` post-processor
- `src/schemas/index.ts` — barrel re-export (created in Task 11)
- `src/schemas/inputs/{ls,find,tree,read,read-many,grep,stat,stat-many,hash,diff,patch,write,edit,mkdir,mv,rm,search-replace,roots}.ts`
- `src/schemas/outputs/{ls,find,tree,read,read-many,grep,stat,stat-many,hash,diff,patch,write,edit,mkdir,mv,rm,search-replace,roots}.ts`
- `__tests__/schemas/snapshot.test.ts`

**Modified files:**

- `src/tools/contract.ts` — add `inputSchemaJson?: StandardSchema`
- `src/tools/task-support.ts` — add `convertSchemasToWire()`, call it before `registerTool`/`registerToolTask`
- `src/schemas.ts` → re-export shim (Task 11), then deleted (Task 12)
- `src/tools/*.ts` — update imports to point at `src/schemas/` (Task 11)
- `__tests__/contract.test.ts` — extend assertions (Task 12)

---

## Task 1: Primitive field builders

**Files:**

- Create: `src/schemas/fields.ts`

- [ ] **Step 1: Create `src/schemas/fields.ts`**

```ts
// src/schemas/fields.ts
import { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';
import { isSafeGlobPattern } from '../lib/paths.js';

function reg<T extends z.ZodType>(schema: T, id: string, extra?: Record<string, unknown>): T {
  z.globalRegistry.add(schema, { id, ...extra });
  return schema;
}

// Runtime: full ISO-8601 UTC validation. Wire: format only (pattern stripped by post-processor).
export const IsoDateTime = reg(
  z.iso.datetime().describe('ISO 8601 date-time (UTC)'),
  'IsoDateTime',
);

export const Sha256Hex = reg(
  z
    .string()
    .regex(/^[a-f0-9]{64}$/u, 'Expected SHA-256 hex digest')
    .describe('SHA-256 hex digest'),
  'Sha256Hex',
);

export const NonNegInt = reg(
  z.int({ error: 'Must be integer' }).min(0, 'Min: 0'),
  'NonNegInt',
);

export const PositiveInt = reg(
  z.int({ error: 'Must be integer' }).min(1, 'Min: 1'),
  'PositiveInt',
);

export const FileType = reg(
  z.enum(['file', 'directory', 'symlink', 'other']),
  'FileType',
);

// Unified across ls/find/grep/search_and_replace — replaces three separate enums.
export const StoppedReason = reg(
  z
    .enum(['maxResults', 'maxFiles', 'maxEntries', 'timeout', 'aborted'])
    .describe(
      'maxResults: result limit hit; maxFiles: file count hit; maxEntries: entry limit hit; timeout: time limit exceeded; aborted: operation cancelled',
    ),
  'StoppedReason',
);

export const ErrorCodeEnum = reg(
  z.enum(ErrorCode).describe('Error code'),
  'ErrorCodeEnum',
);

export const MAX_PATH_LENGTH = 4096;

const PathBase = z.string().max(MAX_PATH_LENGTH, `Path too long (max ${MAX_PATH_LENGTH} chars)`);
// OptionalPath and RequiredPath are not registered (used once per schema, $ref not worth it).
export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase.min(1, 'Path required');

// SafeGlobPattern: includes runtime safety check + examples for discoverability.
// Usage sites do NOT need to add .refine() again — it's baked in here.
export const SafeGlobPattern = reg(
  z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .refine((val) => isSafeGlobPattern(val), {
      error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
    })
    .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
  'SafeGlobPattern',
  { examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'] },
);
```

- [ ] **Step 2: Write a smoke test to verify registry + `$defs` generation**

```ts
// __tests__/schemas/fields.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt } from '../../src/schemas/fields.js';

describe('fields', () => {
  it('IsoDateTime is in globalRegistry', () => {
    assert.ok(z.globalRegistry.has(IsoDateTime));
  });

  it('IsoDateTime $defs entry has no pattern after walk', async () => {
    const schema = z.strictObject({ ts: IsoDateTime });
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    const defs = json['$defs'] as Record<string, unknown>;
    assert.ok('IsoDateTime' in defs, 'IsoDateTime in $defs');
    const def = defs['IsoDateTime'] as Record<string, unknown>;
    assert.equal(def['format'], 'date-time');
    // Pattern still present here — stripped by post-processor in json-schema.ts (Task 3)
    assert.ok('pattern' in def, 'raw output still has pattern (post-processor strips it)');
  });

  it('NonNegInt is in globalRegistry', () => {
    assert.ok(z.globalRegistry.has(NonNegInt));
  });
});
```

- [ ] **Step 3: Run the test**

```bash
node --test --import tsx/esm __tests__/schemas/fields.test.ts
```

Expected: all 3 pass.

- [ ] **Step 4: Commit**

```bash
git add src/schemas/fields.ts __tests__/schemas/fields.test.ts
git commit -m "feat(schemas): add primitive field builders with globalRegistry IDs"
```

---

## Task 2: Composite shared schemas

**Files:**

- Create: `src/schemas/shared.ts`

- [ ] **Step 1: Create `src/schemas/shared.ts`**

```ts
// src/schemas/shared.ts
import { z } from 'zod/v4';

import { ErrorCodeEnum, FileType, IsoDateTime, NonNegInt, PositiveInt } from './fields.js';

function reg<T extends z.ZodType>(schema: T, id: string): T {
  z.globalRegistry.add(schema, { id });
  return schema;
}

export const FileInfoSchema = reg(
  z.strictObject({
    name: z.string().describe('Name'),
    path: z.string().describe('Absolute path'),
    type: FileType.describe('Type'),
    size: NonNegInt.describe('Size (bytes)'),
    tokenEstimate: NonNegInt.optional().describe('Est. tokens (size÷4)'),
    created: IsoDateTime.describe('Created'),
    modified: IsoDateTime.describe('Modified'),
    accessed: IsoDateTime.describe('Accessed'),
    permissions: z.string().describe('Permissions'),
    isHidden: z.boolean().describe('Hidden?'),
    mimeType: z.string().optional().describe('MIME type'),
    symlinkTarget: z.string().optional().describe('Target (symlink)'),
  }),
  'FileInfo',
);

export const ErrorSchema = reg(
  z.strictObject({
    code: ErrorCodeEnum.describe('Error code (e.g. NOT_FOUND)'),
    message: z.string().describe('Human-readable message'),
    path: z.string().optional().describe('Relevant path'),
    suggestion: z.string().optional().describe('Fix suggestion'),
  }),
  'Error',
);

export const OperationSummarySchema = reg(
  z.strictObject({
    total: NonNegInt.describe('Total'),
    succeeded: NonNegInt.describe('Succeeded'),
    failed: NonNegInt.describe('Failed'),
  }),
  'OperationSummary',
);

export const SearchSummarySchema = reg(
  z.strictObject({
    totalMatches: NonNegInt.optional().describe('Total matches found'),
    truncated: z.boolean().optional().describe('Results truncated?'),
    resourceUri: z.string().optional().describe('Full results URI'),
  }),
  'SearchSummary',
);

// Common read-result fields shared by read and read_many item responses.
export const ReadResultSchema = reg(
  z.strictObject({
    content: z.string().optional().describe('Content'),
    truncated: z.boolean().optional().describe('Truncated?'),
    resourceUri: z.string().optional().describe('Full content URI'),
    totalLines: NonNegInt.optional().describe('Total lines'),
    head: PositiveInt.optional().describe('Head lines'),
    tail: PositiveInt.optional().describe('Tail lines'),
    startLine: PositiveInt.optional().describe('Start line'),
    endLine: PositiveInt.optional().describe('End line'),
    linesRead: NonNegInt.optional().describe('Lines read'),
    hasMoreLines: z.boolean().optional().describe('More lines?'),
  }),
  'ReadResult',
);

// Shared read-range input fields (head/tail/startLine/endLine) used in read and read_many.
export interface ReadRangeFields {
  head: ReturnType<typeof z.int>['optional'] extends (...args: unknown[]) => infer R ? R : never;
  tail: ReturnType<typeof z.int>['optional'] extends (...args: unknown[]) => infer R ? R : never;
  startLine: ReturnType<typeof z.int>['optional'] extends (...args: unknown[]) => infer R ? R : never;
  endLine: ReturnType<typeof z.int>['optional'] extends (...args: unknown[]) => infer R ? R : never;
}

interface ReadRangeDescriptions {
  head: string;
  tail: string;
  startLine: string;
  endLine: string;
}

export function createReadRangeFields(descs: ReadRangeDescriptions) {
  return {
    head: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .max(100000, 'Max: 100,000')
      .optional()
      .describe(descs.head),
    tail: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .max(100000, 'Max: 100,000')
      .optional()
      .describe(descs.tail),
    startLine: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .optional()
      .describe(descs.startLine),
    endLine: z
      .int({ error: 'Must be integer' })
      .min(1, 'Min: 1')
      .optional()
      .describe(descs.endLine),
  };
}

// Shared superRefine for read range mutual exclusion (runtime enforcement).
export function validateReadRange(
  value: { head?: number; tail?: number; startLine?: number; endLine?: number },
  ctx: z.RefinementCtx,
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({ code: 'custom', path: ['head'], message: "Cannot use 'head' with 'startLine'/'endLine'", input: value });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({ code: 'custom', path: ['tail'], message: "Cannot use 'tail' with 'head'/'startLine'/'endLine'", input: value });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({ code: 'custom', path: ['endLine'], message: "'endLine' must be >= 'startLine'", input: value });
  }
}

// Shared optional boolean inputs used across multiple tools.
export function defaultFalseBoolean(description: string) {
  return z.boolean().optional().default(false).describe(description);
}

// Shared filter inputs reused by ls/find/tree/grep/search_and_replace.
export const includeHiddenField = () =>
  defaultFalseBoolean('Include hidden items (starting with .)');
export const includeIgnoredField = () =>
  defaultFalseBoolean('Include ignored items (node_modules, .git, etc).');
```

- [ ] **Step 2: Run type-check to verify no errors**

```bash
npm run type-check
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/schemas/shared.ts
git commit -m "feat(schemas): add composite shared schemas with registry IDs"
```

---

## Task 3: Pagination primitives + JSON Schema post-processor

**Files:**

- Create: `src/schemas/pagination.ts`
- Create: `src/schemas/json-schema.ts`

- [ ] **Step 1: Create `src/schemas/pagination.ts`**

```ts
// src/schemas/pagination.ts
import { z } from 'zod/v4';

// Opaque base-64 JSON cursor — treat as opaque; do not parse or construct manually.
// Format: base64(JSON.stringify({ offset: number }))
export const CursorSchema = z
  .string()
  .optional()
  .describe('Pagination cursor from a previous response. Treat as opaque.');

export const NextCursorSchema = z
  .string()
  .optional()
  .describe('Cursor for the next page; absent on the final page.');
```

- [ ] **Step 2: Create `src/schemas/json-schema.ts`**

```ts
// src/schemas/json-schema.ts
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

type JsonSchema = Record<string, unknown>;

// Recursively clean up JSON Schema output produced by z.toJSONSchema():
// - Strip `pattern` from `format: "date-time"` nodes (eliminates the 340-char Zod datetime regex)
// - Strip `maximum: Number.MAX_SAFE_INTEGER` from integer nodes (implicit, just noise)
function walk(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const obj = schema as JsonSchema;
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = walk(value);
  }
  if (result['format'] === 'date-time' && 'pattern' in result) {
    delete result['pattern'];
  }
  if (result['maximum'] === Number.MAX_SAFE_INTEGER && result['type'] === 'integer') {
    delete result['maximum'];
  }
  return result;
}

// Convert a Zod schema to a Standard Schema suitable for MCP tool registration.
// Applies the walk cleanup. Pass an optional `augment` function to inject
// JSON Schema constructs (e.g. `allOf` oneOf constraints) that Zod can't express natively.
export function toToolJsonSchema(
  zodSchema: z.ZodType,
  augment?: (schema: JsonSchema) => JsonSchema,
): ReturnType<typeof fromJsonSchema> {
  const raw = z.toJSONSchema(zodSchema) as JsonSchema;
  const cleaned = walk(raw) as JsonSchema;
  const final = augment ? augment(cleaned) : cleaned;
  return fromJsonSchema(final);
}
```

- [ ] **Step 3: Write a test for the post-processor**

```ts
// __tests__/schemas/json-schema.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt } from '../../src/schemas/fields.js';
import { toToolJsonSchema } from '../../src/schemas/json-schema.js';

describe('toToolJsonSchema', () => {
  it('strips datetime pattern from $defs', () => {
    const schema = z.strictObject({ ts: IsoDateTime });
    const result = toToolJsonSchema(schema) as unknown as Record<string, unknown>;
    // fromJsonSchema wraps — access the underlying JSON via ~standard
    const json = (result as Record<string, unknown>)['~standard'] as Record<string, unknown>;
    // The wrapped schema should not contain 'pattern' string anywhere in $defs
    const str = JSON.stringify(result);
    assert.ok(!str.includes('"pattern"'), 'no pattern in output');
    assert.ok(str.includes('"date-time"'), 'format date-time preserved');
  });

  it('strips MAX_SAFE_INTEGER maximum from integer fields', () => {
    const schema = z.strictObject({ count: NonNegInt });
    const str = JSON.stringify(toToolJsonSchema(schema));
    assert.ok(!str.includes('9007199254740991'), 'no MAX_SAFE_INTEGER in output');
  });

  it('augment function can inject allOf constraints', () => {
    const schema = z.strictObject({ a: z.string().optional(), b: z.string().optional() });
    const result = toToolJsonSchema(schema, (s) => ({
      ...s,
      allOf: [{ if: { required: ['a'] }, then: { not: { required: ['b'] } } }],
    }));
    const str = JSON.stringify(result);
    assert.ok(str.includes('"allOf"'), 'allOf injected');
  });
});
```

- [ ] **Step 4: Run tests**

```bash
node --test --import tsx/esm __tests__/schemas/json-schema.test.ts
```

Expected: all 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/pagination.ts src/schemas/json-schema.ts __tests__/schemas/json-schema.test.ts
git commit -m "feat(schemas): add pagination primitives and JSON Schema post-processor"
```

---

## Task 4: Wire conversion into the registration layer

**Files:**

- Modify: `src/tools/contract.ts`
- Modify: `src/tools/task-support.ts`

- [ ] **Step 1: Add `inputSchemaJson` to `ToolContract`**

In [src/tools/contract.ts](src/tools/contract.ts), add one optional field after `inputSchema`:

```ts
// src/tools/contract.ts  (add after line 26 `inputSchema: ZodType;`)
import type { fromJsonSchema } from '@modelcontextprotocol/server';

type StandardSchema = ReturnType<typeof fromJsonSchema>;

// ...existing fields...

  /**
   * Pre-built Standard Schema for the wire format. When set, used instead of
   * converting `inputSchema` at registration time. Use this to inject JSON Schema
   * constructs (e.g. oneOf/allOf) that Zod can't express natively.
   */
  inputSchemaJson?: StandardSchema;
```

Full updated `contract.ts`:

```ts
// src/tools/contract.ts
import type { fromJsonSchema, Icon } from '@modelcontextprotocol/server';

import type { ZodType } from 'zod/v4';

type StandardSchema = ReturnType<typeof fromJsonSchema>;

export interface ToolContract {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodType;
  inputSchemaJson?: StandardSchema;
  outputSchema?: ZodType;
  annotations?: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
  nuances?: string[];
  gotchas?: string[];
  icons?: Icon[];
  taskSupport?: 'optional' | 'required' | 'forbidden';
}
```

- [ ] **Step 2: Add `convertSchemasToWire` and call it in `task-support.ts`**

In [src/tools/task-support.ts](src/tools/task-support.ts), add the helper function and update the two registration call sites.

After the existing imports block, add:

```ts
import { toToolJsonSchema } from '../schemas/json-schema.js';
```

Add this helper function before `tryRegisterToolTask`:

```ts
// Convert Zod schemas in a tool definition to Standard Schemas for MCP wire format.
// Uses inputSchemaJson when provided (pre-augmented schema, e.g. with oneOf).
function convertSchemasToWire(
  toolDef: Record<string, unknown>,
  inputSchemaJson?: ReturnType<typeof toToolJsonSchema>,
): Record<string, unknown> {
  const result = { ...toolDef };
  result['inputSchema'] = inputSchemaJson ?? toToolJsonSchema(result['inputSchema'] as import('zod/v4').ZodType);
  if (result['outputSchema'] != null) {
    result['outputSchema'] = toToolJsonSchema(result['outputSchema'] as import('zod/v4').ZodType);
  }
  // Remove the helper field — not part of MCP wire protocol
  delete result['inputSchemaJson'];
  return result;
}
```

Update `tryRegisterToolTask` to wrap with `convertSchemasToWire`:

```ts
// In tryRegisterToolTask, replace the registerToolTask call:
server.experimental.tasks.registerToolTask(
  toolName,
  convertSchemasToWire(
    withDefaultIcons(
      { ...toolDef, execution: { ...existingExecution, taskSupport } },
      iconInfo,
    ),
    (toolDef as ToolContract).inputSchemaJson,
  ) as never,
  taskHandler as never,
);
```

Update `registerStandardTool` to wrap the `registerTool` call:

```ts
// In registerStandardTool, replace the registerTool call:
server.registerTool(
  toolDef.name,
  convertSchemasToWire(
    withDefaultIcons({ ...toolDef }, options.iconInfo),
    toolDef.inputSchemaJson,
  ),
  validatedHandler,
);
```

- [ ] **Step 3: Run type-check and tests**

```bash
node scripts/tasks.mjs --quick
```

Expected: exits 0 (lint + type-check + knip pass).

- [ ] **Step 4: Run full test suite to confirm nothing broke**

```bash
node scripts/tasks.mjs
```

Expected: all tests pass. Tool behaviour is unchanged — schemas still Zod at runtime, now Standard Schema on the wire.

- [ ] **Step 5: Commit**

```bash
git add src/tools/contract.ts src/tools/task-support.ts
git commit -m "feat(schemas): wire toToolJsonSchema into registerStandardTool and registerToolTask"
```

---

## Task 5: Snapshot test baseline

**Files:**

- Create: `__tests__/schemas/snapshot.test.ts`

This captures the tool wire schemas BEFORE migration. After migration they'll be smaller — run a diff to measure the win.

- [ ] **Step 1: Create the snapshot test**

```ts
// __tests__/schemas/snapshot.test.ts
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { ALL_TOOLS } from '../../src/tools.js';
import { toToolJsonSchema } from '../../src/schemas/json-schema.js';

const SNAPSHOT_PATH = new URL('./__snapshots__/tool-schemas.json', import.meta.url);

async function buildSnapshot(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const tool of ALL_TOOLS) {
    result[tool.name] = {
      inputSchema: toToolJsonSchema(tool.inputSchema),
      ...(tool.outputSchema ? { outputSchema: toToolJsonSchema(tool.outputSchema) } : {}),
    };
  }
  return result;
}

describe('tool schema snapshots', () => {
  it('matches stored snapshot (update by deleting __snapshots__/tool-schemas.json)', async () => {
    const current = await buildSnapshot();
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      // First run — write snapshot and pass
      await writeFile(SNAPSHOT_PATH, JSON.stringify(current, null, 2), 'utf-8');
      return;
    }
    assert.deepEqual(
      JSON.stringify(current, null, 2),
      JSON.stringify(stored, null, 2),
      'Schema snapshot mismatch — delete __snapshots__/tool-schemas.json to update',
    );
  });

  it('each tool has inputSchema and no $schema at root level', async () => {
    const snap = await buildSnapshot();
    for (const [name, schemas] of Object.entries(snap)) {
      const s = schemas as Record<string, unknown>;
      assert.ok('inputSchema' in s, `${name} has inputSchema`);
    }
  });
});
```

- [ ] **Step 2: Create snapshot directory**

```bash
mkdir -p __tests__/schemas/__snapshots__
```

- [ ] **Step 3: Run the snapshot test (writes baseline)**

```bash
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

Expected: PASS (first run writes the snapshot file).

- [ ] **Step 4: Commit the baseline snapshot**

```bash
git add __tests__/schemas/snapshot.test.ts __tests__/schemas/__snapshots__/tool-schemas.json
git commit -m "test(schemas): add snapshot baseline for tool wire schemas"
```

---

## Task 6: Migrate list-group input + output schemas (ls, find, tree)

**Files:**

- Create: `src/schemas/inputs/ls.ts`, `find.ts`, `tree.ts`
- Create: `src/schemas/outputs/ls.ts`, `find.ts`, `tree.ts`

- [ ] **Step 1: Create `src/schemas/inputs/ls.ts`**

```ts
// src/schemas/inputs/ls.ts
import { z } from 'zod/v4';

import {
  DEFAULT_LIST_MAX_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
} from '../../lib/constants.js';
import { isSafeGlobPattern } from '../../lib/paths.js';
import {
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
} from '../shared.js';
import { CursorSchema, NextCursorSchema } from '../pagination.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';

export const ListDirectoryInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root). Absolute path required if multiple roots.'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_TREE_DEPTH, `Max: ${MAX_TREE_DEPTH}`)
    .optional()
    .describe('Max recursion depth when pattern is provided'),
  maxEntries: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_LIST_ENTRIES, `Max: ${MAX_LIST_ENTRIES}`)
    .optional()
    .default(DEFAULT_LIST_MAX_ENTRIES)
    .describe(`Maximum entries to return before truncation. Default: ${DEFAULT_LIST_MAX_ENTRIES}`),
  sortBy: z
    .enum(['name', 'size', 'modified', 'type'])
    .optional()
    .default('name')
    .describe('Sort field (name, size, modified, type)'),
  pattern: SafeGlobPattern.optional().describe('Optional glob pattern filter (e.g. "**/*.ts")'),
  includeSymlinkTargets: defaultFalseBoolean('Resolve and include symlink targets in results'),
  cursor: CursorSchema,
});
```

- [ ] **Step 2: Create `src/schemas/outputs/ls.ts`**

```ts
// src/schemas/outputs/ls.ts
import { z } from 'zod/v4';

import { FileType, IsoDateTime, NonNegInt, StoppedReason } from '../fields.js';
import { NextCursorSchema } from '../pagination.js';

export const ListDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().optional(),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z.string().optional(),
        type: FileType,
        size: NonNegInt.optional(),
        modified: IsoDateTime.optional(),
      }),
    )
    .optional(),
  totalEntries: NonNegInt.optional(),
  truncated: z.boolean().optional(),
  totalFiles: NonNegInt.optional(),
  totalDirectories: NonNegInt.optional(),
  stoppedReason: StoppedReason.optional(),
  skippedInaccessible: NonNegInt.optional(),
  nextCursor: NextCursorSchema,
});
```

- [ ] **Step 3: Create `src/schemas/inputs/find.ts`**

```ts
// src/schemas/inputs/find.ts
import { z } from 'zod/v4';

import {
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_RESULTS,
} from '../../lib/constants.js';
import { isSafeGlobPattern } from '../../lib/paths.js';
import { includeHiddenField, includeIgnoredField } from '../shared.js';
import { CursorSchema } from '../pagination.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';

export const SearchFilesInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root). Absolute path required if multiple roots.'),
  pattern: SafeGlobPattern.describe('Glob pattern (e.g. "**/*.ts", "src/*.js")'),
  maxResults: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_SEARCH_RESULTS, `Max: ${MAX_SEARCH_RESULTS}`)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe(`Max results (1-${MAX_SEARCH_RESULTS}). Default: ${DEFAULT_SEARCH_RESULTS}`),
  includeIgnored: includeIgnoredField(),
  includeHidden: includeHiddenField(),
  sortBy: z
    .enum(['name', 'size', 'modified', 'path'])
    .optional()
    .default('path')
    .describe('Sort by path, name, size, or modified'),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_SEARCH_DEPTH, `Max: ${MAX_SEARCH_DEPTH}`)
    .optional()
    .describe('Maximum directory depth to scan'),
  cursor: CursorSchema,
});
```

- [ ] **Step 4: Create `src/schemas/outputs/find.ts`**

```ts
// src/schemas/outputs/find.ts
import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt, StoppedReason } from '../fields.js';
import { NextCursorSchema } from '../pagination.js';
import { SearchSummarySchema } from '../shared.js';

export const SearchFilesOutputSchema = SearchSummarySchema.extend({
  ok: z.literal(true),
  root: z.string().optional().describe('Search root'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('Relative path'),
        size: NonNegInt.optional(),
        modified: IsoDateTime.optional(),
      }),
    )
    .optional(),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  skippedInaccessible: NonNegInt.optional().describe('Inaccessible files'),
  stoppedReason: StoppedReason.optional().describe('Why search stopped'),
  nextCursor: NextCursorSchema,
});
```

- [ ] **Step 5: Create `src/schemas/inputs/tree.ts`**

```ts
// src/schemas/inputs/tree.ts
import { z } from 'zod/v4';

import {
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_ENTRIES,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
} from '../../lib/constants.js';
import { includeHiddenField, includeIgnoredField, defaultFalseBoolean } from '../shared.js';
import { OptionalPath } from '../fields.js';

export const TreeInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root). Absolute path required if multiple roots.'),
  maxDepth: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_TREE_DEPTH, `Max: ${MAX_TREE_DEPTH}`)
    .optional()
    .default(DEFAULT_TREE_DEPTH)
    .describe(`Depth (0=root node only, no children). Default: ${DEFAULT_TREE_DEPTH}`),
  maxEntries: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(MAX_TREE_ENTRIES, `Max: ${MAX_TREE_ENTRIES}`)
    .optional()
    .default(DEFAULT_TREE_ENTRIES)
    .describe(`Max entries. Default: ${DEFAULT_TREE_ENTRIES}`),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  includeSizes: defaultFalseBoolean('Include file sizes in tree entries'),
});
```

- [ ] **Step 6: Create `src/schemas/outputs/tree.ts`**

```ts
// src/schemas/outputs/tree.ts
import { z } from 'zod/v4';

import { FileType, NonNegInt } from '../fields.js';

interface TreeEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  relativePath: string;
  size?: number;
  children?: TreeEntry[];
}

const TreeEntrySchema: z.ZodType<TreeEntry> = z.lazy(() =>
  z.strictObject({
    name: z.string().describe('Name'),
    type: FileType.describe('Type'),
    relativePath: z.string().describe('Relative path'),
    size: z.number().optional().describe('File size bytes (when includeSizes)'),
    children: z.array(TreeEntrySchema).optional().describe('Children'),
  }),
);

export const TreeOutputSchema = z.strictObject({
  ok: z.literal(true),
  root: z.string().optional(),
  tree: TreeEntrySchema.optional(),
  ascii: z.string().optional(),
  truncated: z.boolean().optional(),
  totalEntries: NonNegInt.optional(),
});
```

- [ ] **Step 7: Run type-check**

```bash
npm run type-check
```

Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/schemas/inputs/ls.ts src/schemas/inputs/find.ts src/schemas/inputs/tree.ts
git add src/schemas/outputs/ls.ts src/schemas/outputs/find.ts src/schemas/outputs/tree.ts
git commit -m "feat(schemas): add list-group (ls/find/tree) input and output schemas"
```

---

## Task 7: Migrate read-group schemas with oneOf augmentation

**Files:**

- Create: `src/schemas/inputs/read.ts`, `read-many.ts`
- Create: `src/schemas/outputs/read.ts`, `read-many.ts`

- [ ] **Step 1: Create `src/schemas/inputs/read.ts`**

```ts
// src/schemas/inputs/read.ts
import { z } from 'zod/v4';

import { toToolJsonSchema } from '../json-schema.js';
import { createReadRangeFields, defaultFalseBoolean, validateReadRange } from '../shared.js';
import { RequiredPath } from '../fields.js';

export const ReadFileInputSchema = z
  .strictObject({
    path: RequiredPath.describe('Absolute path to file or directory.'),
    ...createReadRangeFields({
      head: 'Read first N lines (preview)',
      tail: 'Read last N lines',
      startLine: 'Start line (1-based, inclusive). Defaults to 1 when endLine is set.',
      endLine: 'End line (1-based, inclusive). Defaults to last line when startLine is set.',
    }),
    includeHash: defaultFalseBoolean('Include SHA-256 hash of full file content'),
  })
  .superRefine(validateReadRange)
  .describe("Use one read mode only: 'head', 'tail', or 'startLine'/'endLine'.");

// Pre-built wire schema with allOf oneOf constraint for client-side validation.
// superRefine above remains the authoritative runtime check.
export const ReadFileInputSchemaJson = toToolJsonSchema(ReadFileInputSchema, (s) => ({
  ...s,
  allOf: [
    ...(Array.isArray(s['allOf']) ? (s['allOf'] as unknown[]) : []),
    {
      if: { required: ['head'] },
      then: { not: { anyOf: [{ required: ['tail'] }, { required: ['startLine'] }, { required: ['endLine'] }] } },
    },
    {
      if: { required: ['tail'] },
      then: { not: { anyOf: [{ required: ['head'] }, { required: ['startLine'] }, { required: ['endLine'] }] } },
    },
  ],
}));
```

- [ ] **Step 2: Create `src/schemas/outputs/read.ts`**

```ts
// src/schemas/outputs/read.ts
import { z } from 'zod/v4';

import { Sha256Hex } from '../fields.js';
import { ReadResultSchema } from '../shared.js';

export const ReadFileOutputSchema = ReadResultSchema.extend({
  ok: z.literal(true),
  path: z.string(),
  contentHash: Sha256Hex.optional().describe('SHA-256 of full file content'),
});
```

Note: `path` is now **required** (not optional) — the handler always sets it.

- [ ] **Step 3: Create `src/schemas/inputs/read-many.ts`**

```ts
// src/schemas/inputs/read-many.ts
import { z } from 'zod/v4';

import { toToolJsonSchema } from '../json-schema.js';
import { createReadRangeFields, validateReadRange } from '../shared.js';
import { RequiredPath } from '../fields.js';

export const ReadMultipleFilesInputSchema = z
  .strictObject({
    paths: z
      .array(RequiredPath)
      .min(1, 'Min 1 path required')
      .max(100, 'Max 100 files')
      .describe('Files to read. e.g. ["src/index.ts"]'),
    ...createReadRangeFields({
      head: 'Read first N lines of each file',
      tail: 'Read last N lines of each file',
      startLine: 'Start line (1-based, inclusive) per file. Defaults to 1 when endLine is set.',
      endLine: 'End line (1-based, inclusive) per file. Defaults to last line when startLine is set.',
    }),
  })
  .superRefine(validateReadRange)
  .describe("Use one read mode only: 'head', 'tail', or 'startLine'/'endLine'.");

export const ReadMultipleFilesInputSchemaJson = toToolJsonSchema(
  ReadMultipleFilesInputSchema,
  (s) => ({
    ...s,
    allOf: [
      ...(Array.isArray(s['allOf']) ? (s['allOf'] as unknown[]) : []),
      {
        if: { required: ['head'] },
        then: { not: { anyOf: [{ required: ['tail'] }, { required: ['startLine'] }, { required: ['endLine'] }] } },
      },
      {
        if: { required: ['tail'] },
        then: { not: { anyOf: [{ required: ['head'] }, { required: ['startLine'] }, { required: ['endLine'] }] } },
      },
    ],
  }),
);
```

- [ ] **Step 4: Create `src/schemas/outputs/read-many.ts`**

```ts
// src/schemas/outputs/read-many.ts
import { z } from 'zod/v4';

import { ErrorSchema, OperationSummarySchema, ReadResultSchema } from '../shared.js';

const ReadManyItemSchema = ReadResultSchema.extend({
  path: z.string().describe('File path'),
  truncationReason: z
    .enum(['head', 'tail', 'range', 'externalized'])
    .optional()
    .describe('Why content was truncated'),
  error: ErrorSchema.optional().describe('Structured error details'),
});

export const ReadMultipleFilesOutputSchema = z.strictObject({
  ok: z.literal(true),
  results: z.array(ReadManyItemSchema),
  summary: OperationSummarySchema.optional(),
});
```

Note: `results` is now **required** — the handler always returns it.

- [ ] **Step 5: Update `READ_FILE_TOOL` contract to use `inputSchemaJson`**

In [src/tools/read.ts](src/tools/read.ts), update the imports and the contract:

```ts
// Replace the imports at top:
import { ReadFileInputSchema, ReadFileInputSchemaJson } from '../schemas/inputs/read.js';
import { ReadFileOutputSchema } from '../schemas/outputs/read.js';

// Update the contract:
export const READ_FILE_TOOL: ToolContract = {
  name: 'read',
  title: 'Read File',
  description: 'Read text file contents. Use `head` to preview first N lines of large files. For multiple files, use `read_many`.',
  inputSchema: ReadFileInputSchema,
  inputSchemaJson: ReadFileInputSchemaJson,
  outputSchema: ReadFileOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: FILE_READ_ICONS,
  nuances: ['Large content is externalized to `filesystem-mcp://result/{id}` and preview is returned inline.'],
  taskSupport: 'forbidden',
} as const;
```

- [ ] **Step 6: Update `READ_MANY_TOOL` contract in `read-multiple.ts`**

Same pattern — add import of `ReadMultipleFilesInputSchemaJson` and set `inputSchemaJson` on the contract.

- [ ] **Step 7: Run type-check + tests**

```bash
node scripts/tasks.mjs
```

Expected: all pass. The `read` and `read_many` output schemas now have `path` and `results` as required — update any test that uses `?.path` null-checks on read results to remove the optional chain.

- [ ] **Step 8: Commit**

```bash
git add src/schemas/inputs/read.ts src/schemas/inputs/read-many.ts
git add src/schemas/outputs/read.ts src/schemas/outputs/read-many.ts
git add src/tools/read.ts src/tools/read-multiple.ts
git commit -m "feat(schemas): add read-group schemas with oneOf allOf constraint"
```

---

## Task 8: Migrate content-search schemas (grep, search_and_replace)

**Files:**

- Create: `src/schemas/inputs/grep.ts`, `search-replace.ts`
- Create: `src/schemas/outputs/grep.ts`, `search-replace.ts`

- [ ] **Step 1: Create `src/schemas/inputs/grep.ts`**

```ts
// src/schemas/inputs/grep.ts
import { z } from 'zod/v4';

import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
} from '../../lib/constants.js';
import { defaultFalseBoolean, includeHiddenField, includeIgnoredField } from '../shared.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';
import { isSafeGlobPattern } from '../../lib/paths.js';

export const SearchContentInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root). Absolute path required if multiple roots.'),
  pattern: z
    .string()
    .min(1, 'Pattern required')
    .max(1000, 'Max 1000 chars')
    .describe('Search text. RE2 regex when `isRegex=true`.'),
  isRegex: defaultFalseBoolean('Treat pattern as RE2 regex (no lookahead/lookbehind/backrefs).'),
  caseSensitive: defaultFalseBoolean('Case-sensitive matching. Default: case-insensitive.'),
  wholeWord: defaultFalseBoolean('Match whole words only'),
  contextLines: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(50, 'Max: 50')
    .optional()
    .default(0)
    .describe('Include N lines of context before/after matches'),
  maxResults: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(MAX_SEARCH_RESULTS, `Max: ${MAX_SEARCH_RESULTS}`)
    .optional()
    .default(DEFAULT_SEARCH_CONTENT_RESULTS)
    .describe(`Maximum match rows to return. Default: ${DEFAULT_SEARCH_CONTENT_RESULTS}`),
  filePattern: SafeGlobPattern.optional()
    .default('**/*')
    .describe('Glob for candidate files (e.g. "**/*.ts")'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
});
```

- [ ] **Step 2: Create `src/schemas/outputs/grep.ts`**

```ts
// src/schemas/outputs/grep.ts
import { z } from 'zod/v4';

import { NonNegInt, PositiveInt, StoppedReason } from '../fields.js';
import { SearchSummarySchema } from '../shared.js';

export const SearchContentOutputSchema = SearchSummarySchema.extend({
  ok: z.literal(true),
  matches: z
    .array(
      z.strictObject({
        file: z.string().describe('Relative path'),
        line: PositiveInt,
        column: NonNegInt.optional().describe('Column of first match (0-based)'),
        content: z.string(),
        matchCount: PositiveInt,
        contextBefore: z.array(z.string()).optional(),
        contextAfter: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  filesScanned: NonNegInt.optional().describe('Files scanned'),
  filesMatched: NonNegInt.optional().describe('Files with matches'),
  skippedTooLarge: NonNegInt.optional().describe('Files skipped: too large'),
  skippedBinary: NonNegInt.optional().describe('Files skipped: binary'),
  skippedInaccessible: NonNegInt.optional().describe('Files skipped: inaccessible'),
  stoppedReason: StoppedReason.optional().describe('Why search stopped'),
});
```

- [ ] **Step 3: Create `src/schemas/inputs/search-replace.ts`**

```ts
// src/schemas/inputs/search-replace.ts
import { z } from 'zod/v4';

import { isSafeGlobPattern } from '../../lib/paths.js';
import { defaultFalseBoolean, includeHiddenField, includeIgnoredField } from '../shared.js';
import { OptionalPath, SafeGlobPattern } from '../fields.js';

export const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root). Absolute path required if multiple roots.'),
  filePattern: SafeGlobPattern.refine(isSafeGlobPattern, {
    error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
  })
    .optional()
    .default('**/*')
    .describe('Glob to filter files. Default: **/*'),
  searchPattern: z
    .string()
    .min(1, 'Search pattern required')
    .max(1000, 'Max 1000 chars')
    .describe('Text to search for. Literal by default; RE2 regex when `isRegex=true`.'),
  replacement: z.string().describe('Replacement text'),
  isRegex: defaultFalseBoolean(
    'Treat searchPattern as RE2 regex. Supports capture groups ($1, $2) in replacement.',
  ),
  caseSensitive: z
    .boolean()
    .optional()
    .default(true)
    .describe('Case-sensitive matching. Default: true.'),
  dryRun: defaultFalseBoolean(
    'Preview matches without writing. Check changedFiles and matches in the response before committing.',
  ),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  returnDiff: defaultFalseBoolean(
    'Return unified diff of changes even if dryRun is false. Default: false.',
  ),
  maxFiles: z
    .int({ error: 'Must be integer' })
    .min(1, 'Min: 1')
    .max(10000, 'Max: 10,000')
    .optional()
    .describe('Max files to process before stopping'),
});
```

- [ ] **Step 4: Create `src/schemas/outputs/search-replace.ts`**

```ts
// src/schemas/outputs/search-replace.ts
import { z } from 'zod/v4';

import { NonNegInt, PositiveInt, StoppedReason } from '../fields.js';
import { ErrorSchema } from '../shared.js';

export const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.literal(true),
  matches: NonNegInt.optional().describe('Total matches found'),
  filesChanged: NonNegInt.optional().describe('Files modified'),
  processedFiles: NonNegInt.optional().describe('Files processed'),
  failedFiles: NonNegInt.optional().describe('Files skipped due to errors'),
  failures: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        error: ErrorSchema.describe('Structured error details'),
      }),
    )
    .optional()
    .describe('Sample of per-file errors'),
  changedFiles: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        matches: PositiveInt.describe('Matches in file'),
      }),
    )
    .optional()
    .describe('Sample of changed files'),
  changedFilesTruncated: z.boolean().optional().describe('Changed file list truncated'),
  diff: z
    .string()
    .optional()
    .describe('Unified diff of changes when `dryRun` or `returnDiff` is enabled'),
  diffTruncated: z.boolean().optional().describe('Diff was truncated to fit size limit'),
  stoppedReason: StoppedReason.optional().describe('Why processing stopped early'),
});
```

- [ ] **Step 5: Run type-check**

```bash
npm run type-check
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/inputs/grep.ts src/schemas/inputs/search-replace.ts
git add src/schemas/outputs/grep.ts src/schemas/outputs/search-replace.ts
git commit -m "feat(schemas): add content-search (grep/search_and_replace) schemas"
```

---

## Task 9: Migrate stat-group + misc schemas

**Files:**

- Create: `src/schemas/inputs/stat.ts`, `stat-many.ts`, `roots.ts`, `hash.ts`, `diff.ts`, `patch.ts`
- Create: `src/schemas/outputs/stat.ts`, `stat-many.ts`, `roots.ts`, `hash.ts`, `diff.ts`, `patch.ts`

- [ ] **Step 1: Create `src/schemas/inputs/stat.ts`**

```ts
// src/schemas/inputs/stat.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

export const GetFileInfoInputSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path to file or directory.'),
});
```

- [ ] **Step 2: Create `src/schemas/outputs/stat.ts`**

```ts
// src/schemas/outputs/stat.ts
import { z } from 'zod/v4';
import { FileInfoSchema } from '../shared.js';

export const GetFileInfoOutputSchema = z.strictObject({
  ok: z.literal(true),
  info: FileInfoSchema,
});
```

Note: `info` is now **required** — the handler always returns it on success.

- [ ] **Step 3: Create `src/schemas/inputs/stat-many.ts`**

```ts
// src/schemas/inputs/stat-many.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

export const GetMultipleFileInfoInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1, 'Min 1 path required')
    .max(100, 'Max 100 files')
    .describe('File/directory paths. e.g. ["src", "lib"]'),
});
```

- [ ] **Step 4: Create `src/schemas/outputs/stat-many.ts`**

```ts
// src/schemas/outputs/stat-many.ts
import { z } from 'zod/v4';
import { ErrorSchema, FileInfoSchema, OperationSummarySchema } from '../shared.js';

export const GetMultipleFileInfoOutputSchema = z.strictObject({
  ok: z.literal(true),
  results: z.array(
    z.strictObject({
      path: z.string(),
      info: FileInfoSchema.optional(),
      error: ErrorSchema.optional(),
    }),
  ),
  summary: OperationSummarySchema.optional(),
});
```

Note: `results` is now **required**.

- [ ] **Step 5: Create `src/schemas/inputs/roots.ts`**

```ts
// src/schemas/inputs/roots.ts
import { z } from 'zod/v4';

export const ListAllowedDirectoriesInputSchema = z
  .strictObject({})
  .describe('No input parameters.');
```

- [ ] **Step 6: Create `src/schemas/outputs/roots.ts`**

```ts
// src/schemas/outputs/roots.ts
import { z } from 'zod/v4';

export const ListAllowedDirectoriesOutputSchema = z.strictObject({
  ok: z.literal(true),
  directories: z.array(z.string()).optional().describe('Allowed directories'),
});
```

- [ ] **Step 7: Create `src/schemas/inputs/hash.ts`**

```ts
// src/schemas/inputs/hash.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

export const CalculateHashInputSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path to file or directory.'),
});
```

- [ ] **Step 8: Create `src/schemas/outputs/hash.ts`**

```ts
// src/schemas/outputs/hash.ts
import { z } from 'zod/v4';
import { NonNegInt, Sha256Hex } from '../fields.js';

export const CalculateHashOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string(),
  hash: Sha256Hex.optional().describe('SHA-256 hash'),
  isDirectory: z.boolean().optional().describe('True if path is a directory'),
  fileCount: NonNegInt.optional().describe('Number of files hashed (directories only)'),
});
```

Note: `path` is required on output.

- [ ] **Step 9: Create `src/schemas/inputs/diff.ts`**

```ts
// src/schemas/inputs/diff.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

export const DiffFilesInputSchema = z.strictObject({
  original: RequiredPath.describe('Path to original file'),
  modified: RequiredPath.describe('Path to modified file'),
  context: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(10000, 'Max: 10,000')
    .optional()
    .describe('Lines of context to include in the diff'),
  ignoreWhitespace: z
    .boolean()
    .optional()
    .default(false)
    .describe('Ignore leading/trailing whitespace when comparing lines'),
  stripTrailingCr: z
    .boolean()
    .optional()
    .default(false)
    .describe('Strip trailing carriage returns before diffing'),
});
```

- [ ] **Step 10: Create `src/schemas/outputs/diff.ts`**

```ts
// src/schemas/outputs/diff.ts
import { z } from 'zod/v4';
import { NonNegInt } from '../fields.js';

export const DiffFilesOutputSchema = z.strictObject({
  ok: z.literal(true),
  diff: z.string().optional().describe('Unified diff content'),
  isIdentical: z.boolean().optional().describe('True if files are identical'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  hunksCount: NonNegInt.optional().describe('Number of diff hunks'),
  truncated: z.boolean().optional().describe('Diff content truncated?'),
  resourceUri: z.string().optional().describe('Full diff content URI'),
});
```

- [ ] **Step 11: Create `src/schemas/inputs/patch.ts`**

```ts
// src/schemas/inputs/patch.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

export const ApplyPatchInputSchema = z.strictObject({
  path: RequiredPath.describe('Path to file to patch'),
  patch: z
    .string()
    .min(1, 'Patch content required')
    .refine((val) => /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(val), {
      error: 'Patch must include hunk headers (e.g., @@ -1,2 +1,2 @@)',
    })
    .describe('Unified diff with @@ hunk headers. Generate with `diff_files`.'),
  fuzzFactor: z
    .int({ error: 'Must be integer' })
    .min(0, 'Min: 0')
    .max(20, 'Max: 20')
    .optional()
    .describe('Maximum fuzzy mismatches per hunk'),
  autoConvertLineEndings: z
    .boolean()
    .optional()
    .default(true)
    .describe('Auto-convert line endings to match target file'),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe('Validate patch without writing. Check `applied` before committing.'),
});
```

- [ ] **Step 12: Create `src/schemas/outputs/patch.ts`**

```ts
// src/schemas/outputs/patch.ts
import { z } from 'zod/v4';
import { NonNegInt } from '../fields.js';
import { ErrorSchema } from '../shared.js';

export const ApplyPatchOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().optional(),
  applied: z.boolean().optional(),
  hunksApplied: NonNegInt.optional().describe('Hunks applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  results: z
    .array(
      z.strictObject({
        path: z.string().describe('File path'),
        applied: z.boolean().describe('Patch applied successfully'),
        hunksApplied: NonNegInt.optional().describe('Hunks applied'),
        linesAdded: NonNegInt.optional().describe('Lines added'),
        linesRemoved: NonNegInt.optional().describe('Lines removed'),
        error: ErrorSchema.optional().describe('Structured error details'),
      }),
    )
    .optional()
    .describe('Per-file results for multi-file patches'),
});
```

- [ ] **Step 13: Run type-check**

```bash
npm run type-check
```

Expected: exits 0.

- [ ] **Step 14: Commit**

```bash
git add src/schemas/inputs/{stat,stat-many,roots,hash,diff,patch}.ts
git add src/schemas/outputs/{stat,stat-many,roots,hash,diff,patch}.ts
git commit -m "feat(schemas): add stat-group and misc (roots/hash/diff/patch) schemas"
```

---

## Task 10: Migrate write-group schemas (write, edit, mkdir, mv, rm)

**Files:**

- Create: `src/schemas/inputs/write.ts`, `edit.ts`, `mkdir.ts`, `mv.ts`, `rm.ts`
- Create: `src/schemas/outputs/write.ts`, `edit.ts`, `mkdir.ts`, `mv.ts`, `rm.ts`

- [ ] **Step 1: Create `src/schemas/inputs/write.ts`**

```ts
// src/schemas/inputs/write.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

export const WriteFileInputSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path to file or directory.'),
  content: z.string().describe('Content to write'),
});
```

- [ ] **Step 2: Create `src/schemas/outputs/write.ts`**

```ts
// src/schemas/outputs/write.ts
import { z } from 'zod/v4';
import { NonNegInt } from '../fields.js';

export const WriteFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string(),
  bytesWritten: NonNegInt.optional(),
});
```

Note: `path` is required on output.

- [ ] **Step 3: Create `src/schemas/inputs/edit.ts`**

```ts
// src/schemas/inputs/edit.ts
import { z } from 'zod/v4';
import { defaultFalseBoolean } from '../shared.js';
import { RequiredPath } from '../fields.js';

export const EditFileInputSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path to file or directory.'),
  edits: z
    .array(
      z.strictObject({
        oldText: z
          .string()
          .min(1, 'oldText required')
          .max(102400, 'Max 100KB')
          .describe(
            'Exact literal string to replace (character-for-character). Include 3–5 lines of context for unique targeting.',
          ),
        newText: z.string().describe('Replacement string. Preserve surrounding indentation style.'),
      }),
    )
    .min(1, 'Min 1 edit required')
    .describe('List of replacements to apply sequentially. Each edit replaces the first occurrence of oldText.'),
  dryRun: defaultFalseBoolean('Preview edits without writing. Check `unmatchedEdits` in response.'),
  ignoreWhitespace: defaultFalseBoolean(
    'Treat all whitespace sequences as equivalent when matching oldText.',
  ),
});
```

- [ ] **Step 4: Create `src/schemas/outputs/edit.ts`**

```ts
// src/schemas/outputs/edit.ts
import { z } from 'zod/v4';
import { NonNegInt, PositiveInt } from '../fields.js';

export const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().optional(),
  appliedEdits: NonNegInt.optional(),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  lineRange: z
    .tuple([PositiveInt, PositiveInt])
    .optional()
    .describe('Line range modified [start, end] (1-based)'),
  unmatchedEdits: z.array(z.string()).optional().describe('Edits that could not be applied'),
  diff: z.string().optional().describe('Unified diff of changes (dryRun)'),
});
```

Note: `ok` is now `z.literal(true)` (was `z.boolean()` — fixes discriminator inconsistency).

- [ ] **Step 5: Create `src/schemas/inputs/mkdir.ts`** (post-breaking-change shape — paths only)

```ts
// src/schemas/inputs/mkdir.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

// NOTE: singular `path` is intentionally removed (breaking change — Task 12).
// Callers must use `paths: ["/single/path"]` for single-directory creation.
export const CreateDirectoryInputSchema = z.strictObject({
  paths: z
    .array(RequiredPath)
    .min(1, 'Min 1 path required')
    .describe('Absolute paths to directories to create'),
});
```

- [ ] **Step 6: Create `src/schemas/outputs/mkdir.ts`**

```ts
// src/schemas/outputs/mkdir.ts
import { z } from 'zod/v4';

export const CreateDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true),
  paths: z.array(z.string()),
});
```

Note: `paths` is required; singular `path` is removed.

- [ ] **Step 7: Create `src/schemas/inputs/mv.ts`** (post-breaking-change shape — sources only)

```ts
// src/schemas/inputs/mv.ts
import { z } from 'zod/v4';
import { RequiredPath } from '../fields.js';

// NOTE: singular `source` is intentionally removed (breaking change — Task 12).
// Callers must use `sources: ["/single/source"]` for single-file moves.
export const MoveFileInputSchema = z.strictObject({
  sources: z
    .array(RequiredPath)
    .min(1, 'Min 1 source required')
    .describe('Paths to move'),
  destination: RequiredPath.describe('New path'),
});
```

- [ ] **Step 8: Create `src/schemas/outputs/mv.ts`**

```ts
// src/schemas/outputs/mv.ts
import { z } from 'zod/v4';
import { ErrorSchema } from '../shared.js';

export const MoveFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  sources: z.array(z.string()),
  destination: z.string(),
  failed: z
    .array(
      z.strictObject({
        source: z.string().describe('Source path'),
        error: ErrorSchema.describe('Structured error details'),
      }),
    )
    .optional()
    .describe('List of files that failed to move'),
});
```

Note: `ok` is `z.literal(true)`, `sources` and `destination` required, singular `source` removed.

- [ ] **Step 9: Create `src/schemas/inputs/rm.ts`**

```ts
// src/schemas/inputs/rm.ts
import { z } from 'zod/v4';
import { defaultFalseBoolean } from '../shared.js';
import { RequiredPath } from '../fields.js';

export const DeleteFileInputSchema = z.strictObject({
  path: RequiredPath.describe('Absolute path to file or directory.'),
  recursive: defaultFalseBoolean('Delete non-empty directories'),
  ignoreIfNotExists: defaultFalseBoolean('No error if missing'),
});
```

- [ ] **Step 10: Create `src/schemas/outputs/rm.ts`**

```ts
// src/schemas/outputs/rm.ts
import { z } from 'zod/v4';

export const DeleteFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string(),
});
```

Note: `path` required on output.

- [ ] **Step 11: Run type-check**

```bash
npm run type-check
```

Expected: exits 0.

- [ ] **Step 12: Commit**

```bash
git add src/schemas/inputs/{write,edit,mkdir,mv,rm}.ts
git add src/schemas/outputs/{write,edit,mkdir,mv,rm}.ts
git commit -m "feat(schemas): add write-group (write/edit/mkdir/mv/rm) schemas"
```

---

## Task 11: Create barrel + make `src/schemas.ts` a re-export shim, update tool imports

**Files:**

- Create: `src/schemas/index.ts`
- Modify: `src/schemas.ts` → re-export shim
- Modify: all `src/tools/*.ts` files that import from `../schemas.js`

- [ ] **Step 1: Create `src/schemas/index.ts`**

```ts
// src/schemas/index.ts — barrel export for all tool schemas
export * from './inputs/ls.js';
export * from './inputs/find.js';
export * from './inputs/tree.js';
export * from './inputs/read.js';
export * from './inputs/read-many.js';
export * from './inputs/grep.js';
export * from './inputs/stat.js';
export * from './inputs/stat-many.js';
export * from './inputs/roots.js';
export * from './inputs/hash.js';
export * from './inputs/diff.js';
export * from './inputs/patch.js';
export * from './inputs/write.js';
export * from './inputs/edit.js';
export * from './inputs/mkdir.js';
export * from './inputs/mv.js';
export * from './inputs/rm.js';
export * from './inputs/search-replace.js';
export * from './outputs/ls.js';
export * from './outputs/find.js';
export * from './outputs/tree.js';
export * from './outputs/read.js';
export * from './outputs/read-many.js';
export * from './outputs/grep.js';
export * from './outputs/stat.js';
export * from './outputs/stat-many.js';
export * from './outputs/roots.js';
export * from './outputs/hash.js';
export * from './outputs/diff.js';
export * from './outputs/patch.js';
export * from './outputs/write.js';
export * from './outputs/edit.js';
export * from './outputs/mkdir.js';
export * from './outputs/mv.js';
export * from './outputs/rm.js';
export * from './outputs/search-replace.js';
```

- [ ] **Step 2: Replace `src/schemas.ts` with a re-export shim**

```ts
// src/schemas.ts — transitional shim; all real schemas live in src/schemas/
// This file will be deleted after all tool imports are updated.
export * from './schemas/index.js';
```

- [ ] **Step 3: Update tool-file imports to point at `src/schemas/`**

For each tool file in `src/tools/`, update the import from `'../schemas.js'` to import from the specific new schema files. Run this grep to see all affected files:

```bash
grep -l "from '../schemas.js'" src/tools/*.ts
```

Expected: ~17 files. For each file, replace:

```ts
import { XxxInputSchema, XxxOutputSchema } from '../schemas.js';
```

with:

```ts
import { XxxInputSchema } from '../schemas/inputs/xxx.js';
import { XxxOutputSchema } from '../schemas/outputs/xxx.js';
```

Example for `src/tools/list-directory.ts`:

```ts
// Before:
import { ListDirectoryInputSchema, ListDirectoryOutputSchema } from '../schemas.js';
// After:
import { ListDirectoryInputSchema } from '../schemas/inputs/ls.js';
import { ListDirectoryOutputSchema } from '../schemas/outputs/ls.js';
```

- [ ] **Step 4: Run type-check and full test suite**

```bash
node scripts/tasks.mjs
```

Expected: all pass. The shim means `src/schemas.ts` still resolves for anything not yet updated.

- [ ] **Step 5: Delete the snapshot and re-baseline it (schema has changed)**

```bash
rm __tests__/schemas/__snapshots__/tool-schemas.json
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

Expected: PASS (writes new snapshot). Verify the new snapshot JSON is smaller: no long `pattern` strings, `$defs` blocks present.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/index.ts src/schemas.ts src/tools/*.ts
git add __tests__/schemas/__snapshots__/tool-schemas.json
git commit -m "feat(schemas): create barrel, convert schemas.ts to shim, update tool imports"
```

---

## Task 12: Breaking changes — remove singular forms from `mv` and `mkdir`

**Files:**

- Modify: `src/tools/move-file.ts`
- Modify: `src/tools/create-directory.ts`
- Modify: any test that passes `source:` to `mv` or `path:` to `mkdir`

- [ ] **Step 1: Find all test calls using the old singular forms**

```bash
grep -rn "source:" __tests__/
grep -rn "\"path\":" __tests__/ | grep -i mkdir
```

Note every file and line that needs updating.

- [ ] **Step 2: Update `src/tools/move-file.ts`**

The handler currently branches on `args.source` vs `args.sources`. Remove that branch — always use `args.sources`:

```ts
// In handleMoveFile (or equivalent), replace the dual-path dispatch:
// BEFORE:
const sourcePaths = args.sources ?? (args.source ? [args.source] : []);

// AFTER:
const sourcePaths = args.sources;
```

Remove any output branch that emits `source:` (singular); always emit `sources:`.

In the contract `MOVE_FILE_TOOL`, update `inputSchema` and `outputSchema` to the new imports:

```ts
import { MoveFileInputSchema } from '../schemas/inputs/mv.js';
import { MoveFileOutputSchema } from '../schemas/outputs/mv.js';
```

- [ ] **Step 3: Update `src/tools/create-directory.ts`**

Remove the dual-path `superRefine` branch — always use `args.paths`:

```ts
// In handleCreateDirectory, replace:
// BEFORE:
const dirPaths = args.paths ?? (args.path ? [args.path] : []);

// AFTER:
const dirPaths = args.paths;
```

In the contract `CREATE_DIRECTORY_TOOL`, update imports:

```ts
import { CreateDirectoryInputSchema } from '../schemas/inputs/mkdir.js';
import { CreateDirectoryOutputSchema } from '../schemas/outputs/mkdir.js';
```

- [ ] **Step 4: Update test files to use array forms**

For every test call found in Step 1, change:

```ts
// mv:
await client.callTool({ name: 'mv', arguments: { source: '/a/b', destination: '/c/d' } });
// to:
await client.callTool({ name: 'mv', arguments: { sources: ['/a/b'], destination: '/c/d' } });

// mkdir:
await client.callTool({ name: 'mkdir', arguments: { path: '/some/dir' } });
// to:
await client.callTool({ name: 'mkdir', arguments: { paths: ['/some/dir'] } });
```

- [ ] **Step 5: Run full test suite**

```bash
node scripts/tasks.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/move-file.ts src/tools/create-directory.ts __tests__/
git commit -m "feat(schemas)!: remove singular source/path from mv/mkdir — use arrays only"
```

---

## Task 13: Delete `src/schemas.ts`, update contract test, final verification

**Files:**

- Delete: `src/schemas.ts`
- Modify: `__tests__/contract.test.ts`

- [ ] **Step 1: Verify no remaining imports from `../schemas.js`**

```bash
grep -rn "from '../schemas.js'" src/
```

Expected: 0 results. If any remain, update them now (same pattern as Task 11 Step 3).

- [ ] **Step 2: Delete `src/schemas.ts`**

```bash
git rm src/schemas.ts
```

- [ ] **Step 3: Run type-check to confirm nothing breaks**

```bash
npm run type-check
```

Expected: exits 0.

- [ ] **Step 4: Extend `__tests__/contract.test.ts` with schema quality assertions**

Add the following assertions to the existing contract test:

```ts
import { z } from 'zod/v4';
import { toToolJsonSchema } from '../src/schemas/json-schema.js';

// Add inside the contract test suite:

it('all success output schemas have ok: literal(true)', () => {
  for (const tool of ALL_TOOLS) {
    if (!tool.outputSchema) continue;
    const schema = tool.outputSchema as z.ZodObject<{ ok: z.ZodType }>;
    const shape = (schema as unknown as { _zod: { def: { shape: Record<string, z.ZodType> } } })._zod?.def?.shape;
    if (!shape?.['ok']) continue;
    const okJson = z.toJSONSchema(shape['ok']) as Record<string, unknown>;
    assert.equal(
      okJson['const'],
      true,
      `Tool "${tool.name}" outputSchema.ok should be z.literal(true), got: ${JSON.stringify(okJson)}`,
    );
  }
});

it('mv and mkdir input schemas have no singular source/path field', () => {
  const mvTool = ALL_TOOLS.find((t) => t.name === 'mv');
  const mkdirTool = ALL_TOOLS.find((t) => t.name === 'mkdir');
  assert.ok(mvTool && mkdirTool);
  const mvJson = toToolJsonSchema(mvTool.inputSchema) as unknown as Record<string, unknown>;
  const mkdirJson = toToolJsonSchema(mkdirTool.inputSchema) as unknown as Record<string, unknown>;
  const mvStr = JSON.stringify(mvJson);
  const mkdirStr = JSON.stringify(mkdirJson);
  assert.ok(!mvStr.includes('"source"') || mvStr.includes('"sources"'), 'mv has no singular source field');
  assert.ok(!mkdirStr.includes('"path"') || mkdirStr.includes('"paths"'), 'mkdir has no singular path field');
});

it('no datetime pattern strings in any tool wire schema', () => {
  for (const tool of ALL_TOOLS) {
    const inputStr = JSON.stringify(toToolJsonSchema(tool.inputSchema));
    assert.ok(!inputStr.includes('"pattern"'), `Tool "${tool.name}" inputSchema has datetime pattern`);
    if (tool.outputSchema) {
      const outputStr = JSON.stringify(toToolJsonSchema(tool.outputSchema));
      assert.ok(!outputStr.includes('"pattern"'), `Tool "${tool.name}" outputSchema has datetime pattern`);
    }
  }
});
```

- [ ] **Step 5: Run the full suite**

```bash
node scripts/tasks.mjs
```

Expected: all pass — including the new contract assertions.

- [ ] **Step 6: Re-run snapshot to confirm no drift since Task 11**

```bash
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

Expected: PASS (snapshot matches). If it fails, schemas changed unexpectedly — investigate before committing.

- [ ] **Step 7: Final commit**

```bash
git add __tests__/contract.test.ts
git commit -m "test(schemas): assert ok literal, no singular mv/mkdir fields, no datetime pattern"
```

- [ ] **Step 8: Verify wire payload size reduction**

```bash
node --import tsx/esm -e "
import { ALL_TOOLS } from './src/tools.js';
import { toToolJsonSchema } from './src/schemas/json-schema.js';
let total = 0;
for (const t of ALL_TOOLS) {
  const i = JSON.stringify(toToolJsonSchema(t.inputSchema)).length;
  const o = t.outputSchema ? JSON.stringify(toToolJsonSchema(t.outputSchema)).length : 0;
  total += i + o;
}
console.log('Total wire schema bytes:', total);
"
```

Compare against the baseline snapshot byte count to confirm reduction. Document the before/after in the PR description.
