# Schema Handling Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project's `as unknown as StandardSchemaWithJSON` casts with a real `withJsonSchema` adapter, activate the dead `inputSchemaAugment` hook so the `read` tool's mutually-exclusive parameters reach `tools/list` clients, and consolidate the duplicated `FileType` definitions into a single source of truth.

**Architecture:** Build a tiny `withJsonSchema(zodSchema, jsonSchema)` helper in `src/tools/define.ts` that promotes a `StandardSchemaV1` Zod schema (current Zod 4.4.3 shape) into a `StandardSchemaWithJSON` by attaching `~standard.jsonSchema.input/output`. Reuse the helper for both `McpServer.registerTool` and `registerToolTask`, sharing one JSON-Schema computation per direction (input/output) with the `DefinedTool` projection. Apply `def.inputSchemaAugment` to the input JSON Schema before that single computation is consumed.

**Tech Stack:** TypeScript (strict), Zod 4.4.3 (`zod/v4`), `@modelcontextprotocol/server@2.0.0-alpha.2`, Node.js `node:test`.

---

## File Structure

- Modify [src/schema.ts](src/schema.ts) — Promote `FileType` to use a shared `as const` tuple and derive the TS type via `z.infer`. Add a `FILE_TYPES` export for symmetry.
- Modify [src/core/fs.ts](src/core/fs.ts) — Remove the local `export type FileType = 'file' | 'directory' | 'symlink' | 'other'` declaration, import the type from `../schema.js`.
- Modify [src/tools/search-files.ts](src/tools/search-files.ts) — Update the `type FileType` re-export source from `../core/fs.js` to `../schema.js` (single import line).
- Modify [src/tools/define.ts](src/tools/define.ts) — Add private `withJsonSchema` helper, apply `inputSchemaAugment` before computing the shared input JSON Schema, replace the two `as unknown as StandardSchemaWithJSON<...>` casts in `register` and the task branch, and drop the now-redundant separate `inputJsonSchema`/`outputJsonSchema` variables in favour of helpers that hand the same JSON Schema to both `DefinedTool` and the SDK.
- Modify [**tests**/schemas/**snapshots**/tool-schemas.json](__tests__/schemas/__snapshots__/tool-schemas.json) — Regenerate via `FS_UPDATE_SCHEMA_SNAPSHOT=1`. Expected change: the `read` tool input schema gains the `allOf` mutex block; everything else is byte-identical.
- Add (test) [**tests**/unit/define-tool.test.ts](__tests__/unit/define-tool.test.ts) — Append two assertions for the helper's behaviour (or new test file `define-with-json-schema.test.ts` if append is awkward).

---

## Task 1: Consolidate `FileType` definitions

**Files:**

- Modify: [src/schema.ts](src/schema.ts) (around lines 39-41)
- Modify: [src/core/fs.ts](src/core/fs.ts) (line 47)
- Modify: [src/tools/search-files.ts](src/tools/search-files.ts) (line 16)
- Modify: [src/tools/list.ts](src/tools/list.ts) (line 24 — already imports from schema, verify only)

- [ ] **Step 1: Write the failing test**

Append the following test to a new file at `__tests__/unit/file-type.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileType } from '../../src/core/fs.js';
import { FILE_TYPES, FileType as FileTypeSchema } from '../../src/schema.js';

test('FILE_TYPES contains the four members and FileType infers from it', () => {
  assert.deepEqual([...FILE_TYPES], ['file', 'directory', 'symlink', 'other']);
  const ok: FileType = 'symlink';
  assert.equal(FileTypeSchema.parse(ok), 'symlink');
  assert.throws(() => FileTypeSchema.parse('block-device'));
});

test('core/fs.ts FileType matches the Zod-derived inference', () => {
  // Type-level assertion — must compile with no errors.
  const _check: FileType = 'file';
  assert.equal(_check, 'file');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/file-type.test.ts"`
Expected: FAIL — `FILE_TYPES` is not exported from `src/schema.ts` yet.

- [ ] **Step 3: Update `src/schema.ts` to expose a tuple and derive the type**

Replace lines 39-41 in [src/schema.ts](src/schema.ts) with:

```typescript
export const FILE_TYPES = ['file', 'directory', 'symlink', 'other'] as const;
export type FileType = (typeof FILE_TYPES)[number];
export const FileType = z.enum(FILE_TYPES).meta({ id: 'FileType', title: 'File Type' });
```

Note: this exports both a _value_ (`FileType` — the Zod enum) and a _type_ (`FileType` — the inferred union). TypeScript allows the same name in both namespaces.

- [ ] **Step 4: Delete the duplicate type in `src/core/fs.ts`**

Replace line 47 in [src/core/fs.ts](src/core/fs.ts):

```typescript
export type FileType = 'file' | 'directory' | 'symlink' | 'other';
```

…with a re-export so existing imports of `FileType` from `core/fs.js` keep working:

```typescript
export type { FileType } from '../schema.js';
```

- [ ] **Step 5: Verify `tools/list.ts` and `tools/search-files.ts` still resolve**

Run: `node scripts/tasks.mjs check --quick`
Expected: PASS (format → lint → type-check → knip all green).

If any tool still imports `FileType` from `../core/fs.js`, leave it — the re-export keeps it valid.

- [ ] **Step 6: Run the new test and the full test suite**

Run: `node --test --import tsx/esm "__tests__/unit/file-type.test.ts"`
Expected: PASS.

Run: `node scripts/tasks.mjs test --name-pattern "FileType|file-type"`
Expected: 2/2 passing.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts src/core/fs.ts __tests__/unit/file-type.test.ts
git commit -m "refactor(schema): consolidate FileType to single source of truth in schema.ts"
```

---

## Task 2: Introduce `withJsonSchema` adapter and remove `as unknown as` casts

**Files:**

- Modify: [src/tools/define.ts](src/tools/define.ts) (around lines 502-580)
- Modify: [**tests**/unit/define.test.ts](__tests__/unit/define.test.ts) — extend with structural assertions

- [ ] **Step 1: Write the failing test**

Append to [**tests**/unit/define.test.ts](__tests__/unit/define.test.ts):

```typescript
test('defineTool produces StandardSchemaWithJSON-shaped inputSchema/outputSchema', () => {
  const tool = defineTool({
    name: 'shape_tool',
    title: 'Shape Tool',
    description: 'Verifies the registered schema carries jsonSchema converters',
    input: z.strictObject({ a: z.string() }),
    output: z.strictObject({ b: z.string() }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async () => ({ structured: { b: 'ok' } }),
  });

  // Public DefinedTool surface — JSON Schema objects ready for `tools/list`.
  const inputJsonSchema = tool.inputSchema as Record<string, unknown>;
  const outputJsonSchema = tool.outputSchema as Record<string, unknown>;
  assert.equal(inputJsonSchema['type'], 'object');
  assert.equal(outputJsonSchema['type'], 'object');
  const inputProps = inputJsonSchema['properties'] as Record<string, unknown>;
  assert.ok(inputProps && 'a' in inputProps);
});
```

- [ ] **Step 2: Run test to verify it fails or already passes**

Run: `node --test --import tsx/esm "__tests__/unit/define.test.ts"`
Expected: PASS for the new test (current code already populates these). If it FAILS, fix the assertion before continuing — your fixture must match the real `DefinedTool` shape.

This step is a **regression net** for Task 2, not a TDD red. Continue.

- [ ] **Step 3: Add the `withJsonSchema` helper to `src/tools/define.ts`**

In [src/tools/define.ts](src/tools/define.ts), insert this helper just above `defineTool` (anchor: above the line `export function defineTool<I extends z.ZodType, O extends z.ZodType>(`):

```typescript
function withJsonSchema<T extends z.ZodType>(
  schema: T,
  jsonSchema: Record<string, unknown>,
): StandardSchemaWithJSON<z.infer<T>, z.infer<T>> {
  const standard = (schema as unknown as { '~standard': Record<string, unknown> })['~standard'];
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  } as StandardSchemaWithJSON<z.infer<T>, z.infer<T>>;
}
```

Why the inner cast: Zod 4.4.3's `~standard` is typed as `StandardSchemaV1.Props` (no `jsonSchema` member). We copy the existing `validate`, `version`, `vendor`, `types` properties and bolt on `jsonSchema`. The outer return cast satisfies the consumer's `StandardSchemaWithJSON` expectation. Both casts are confined to this one helper.

- [ ] **Step 4: Rewrite the `defineTool` body to use the helper**

Replace lines 502-580 in [src/tools/define.ts](src/tools/define.ts) (the entire `defineTool` function body) with:

```typescript
export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const baseInputJsonSchema = z.toJSONSchema(def.input, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  const inputJsonSchema: Record<string, unknown> = def.inputSchemaAugment
    ? def.inputSchemaAugment(baseInputJsonSchema)
    : baseInputJsonSchema;
  const outputJsonSchema = z.toJSONSchema(def.output, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;

  const inputSchemaWithJson = withJsonSchema(def.input, inputJsonSchema);
  const outputSchemaWithJson = withJsonSchema(def.output, outputJsonSchema);

  const tool: DefinedTool = {
    name: def.name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    execution: def.execution ?? { taskSupport: 'forbidden' },
    nuances: def.nuances ?? [],
    gotchas: def.gotchas ?? [],
    inputSchema: inputJsonSchema as Tool['inputSchema'],
    outputSchema: outputJsonSchema as Tool['inputSchema'],

    register(deps: ToolDeps) {
      const toolDefShape = {
        title: def.title,
        description: def.description,
        inputSchema: inputSchemaWithJson,
        outputSchema: outputSchemaWithJson,
        annotations: def.annotations,
      };

      const serverCtxHandler = async (
        args: z.infer<I>,
        ctx: ServerContext,
      ): Promise<CallToolResult> => {
        const executor = new ToolExecutor<I, O>(def.name, toToolCtx(ctx, deps), def, args);
        return executor.execute(args, deps);
      };

      const taskSupport = def.execution?.taskSupport;
      if (taskSupport && taskSupport !== 'forbidden' && deps.orchestrator) {
        const taskToolDefShape = {
          title: def.title,
          description: def.description,
          inputSchema: inputSchemaWithJson,
          outputSchema: outputSchemaWithJson,
          annotations: def.annotations,
          execution: { ...def.execution, taskSupport },
        };

        deps.server.experimental.tasks.registerToolTask(
          def.name,
          taskToolDefShape,
          deps.orchestrator.wrapToolTask(
            async (args, ctx) => {
              const executor = new ToolExecutor<I, O>(def.name, ctx, def, args as z.infer<I>);
              return executor.execute(args, deps) as Promise<ToolResult<Record<string, unknown>>>;
            },
            {
              toolName: def.name,
              toolTitle: def.title,
              startStatusMessage: (args: unknown) =>
                plainMessage('start', resolveProgressCtx(def, args as z.infer<I>)),
              deps,
            },
          ),
        );
        return;
      }

      deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
    },
  };

  return tool;
}
```

Key changes:

- One `z.toJSONSchema` call per direction; `inputSchemaAugment` applied between the base and consumed forms.
- `inputSchemaWithJson` and `outputSchemaWithJson` are computed once and reused.
- No `as unknown as StandardSchemaWithJSON<...>` casts at call sites.

- [ ] **Step 5: Run type-check**

Run: `node scripts/tasks.mjs check --quick`
Expected: PASS. If TypeScript complains about `Tool['inputSchema']` shape, the `as Tool['inputSchema']` cast on the `DefinedTool` projection lines preserves the existing public contract.

- [ ] **Step 6: Run the full test suite**

Run: `node scripts/tasks.mjs test`
Expected: PASS. The snapshot test will FAIL because the read tool's input schema now includes the `allOf` block. Do **not** update the snapshot yet — Task 3 explicitly owns that step. If the snapshot test fails here, that confirms the helper is correctly threading the augmented JSON Schema through registration, which is the intended behaviour change.

If the snapshot test is the ONLY failure, continue to Task 3. If any other test fails, stop and diagnose.

- [ ] **Step 7: Commit**

```bash
git add src/tools/define.ts __tests__/unit/define.test.ts
git commit -m "refactor(tools): add withJsonSchema helper, eliminate StandardSchemaWithJSON casts"
```

---

## Task 3: Wire up `inputSchemaAugment` (already invoked by Task 2) and update snapshot

The augment is already wired by Task 2's `defineTool` rewrite. This task verifies the behaviour and updates the snapshot.

**Files:**

- Verify: [src/tools/read.ts](src/tools/read.ts) (lines 370-383 — no edits, just confirms the constraint is now exported)
- Modify: [**tests**/schemas/**snapshots**/tool-schemas.json](__tests__/schemas/__snapshots__/tool-schemas.json) — regenerate
- Add (test): one assertion in [**tests**/schemas/json-schema.test.ts](__tests__/schemas/json-schema.test.ts) — the advertised read schema now rejects `{ head, tail }` together

- [ ] **Step 1: Write the failing test**

Append to [**tests**/schemas/json-schema.test.ts](__tests__/schemas/json-schema.test.ts):

```typescript
it('read: advertised schema rejects simultaneous head+tail', async () => {
  const schema = await getInputSchema('read');
  const v = new Validator(schema, '2020-12', false);
  const result = v.validate({ path: '/x', head: 5, tail: 5 });
  assert.ok(
    !result.valid,
    'read tool must publish allOf mutex for head/tail (input parameter conflict)',
  );
});

it('read: advertised schema rejects simultaneous offset+startLine', async () => {
  const schema = await getInputSchema('read');
  const v = new Validator(schema, '2020-12', false);
  const result = v.validate({ path: '/x', offset: 0, startLine: 10 });
  assert.ok(
    !result.valid,
    'read tool must publish allOf mutex for offset/startLine (input parameter conflict)',
  );
});
```

- [ ] **Step 2: Run the new test to verify it fails on a stale snapshot AND that the schema is now augmented**

Run: `node --test --import tsx/esm "__tests__/schemas/json-schema.test.ts"`
Expected: the two new tests PASS (the augmented schema now reaches `tools/list`). If they FAIL, the helper from Task 2 is not threading `inputSchemaAugment` correctly — return to Task 2 step 4.

- [ ] **Step 3: Regenerate the snapshot**

Run: `FS_UPDATE_SCHEMA_SNAPSHOT=1 node --test --import tsx/esm "__tests__/schemas/snapshot.test.ts"`
Expected: writes a new `__tests__/schemas/__snapshots__/tool-schemas.json`.

- [ ] **Step 4: Inspect the diff for the `read` entry only**

Run: `git diff __tests__/schemas/__snapshots__/tool-schemas.json`
Expected: the only meaningful change is under the `"read"` key — an added top-level `"allOf"` array containing the eight `{ "not": { "required": [...] } }` clauses from `read.ts:370-383`. No other tool entries should change. If you see drift in unrelated tools, something is wrong — diagnose before continuing.

- [ ] **Step 5: Run the full test suite**

Run: `node scripts/tasks.mjs test`
Expected: PASS. Snapshot test now matches the regenerated baseline.

- [ ] **Step 6: Commit**

```bash
git add __tests__/schemas/json-schema.test.ts __tests__/schemas/__snapshots__/tool-schemas.json
git commit -m "feat(tools/read): publish head/tail/offset/startLine mutex constraints via JSON Schema allOf"
```

---

## Task 4: Final verification

- [ ] **Step 1: Run the full check suite**

Run: `node scripts/tasks.mjs check`
Expected: format → lint → type-check → knip → test → rebuild all PASS.

- [ ] **Step 2: Smoke-test the server**

Run the MCP smoke-test skill (or manual equivalent):

```bash
node --test --import tsx/esm "__tests__/contract.test.ts"
```

Expected: PASS. Pay attention to:

- `'all input schema properties have descriptions'` — your changes preserve descriptions.
- `'list.maxDepth default is 1 and description matches constant'` — unaffected.

- [ ] **Step 3: Confirm no `as unknown as StandardSchemaWithJSON` remains**

Run: `grep -RnE "as unknown as StandardSchemaWithJSON" src/`
Expected: no matches. Casts are now confined to the single `withJsonSchema` helper.

- [ ] **Step 4: Confirm `FileType` is single-source**

Run: `grep -RnE "type FileType\s*=" src/`
Expected: exactly one match in `src/schema.ts`. `src/core/fs.ts` should now read `export type { FileType } from '../schema.js';`.

- [ ] **Step 5: Final commit (only if any cleanup edits were needed)**

```bash
git status
# If no changes, skip this step.
git add -A
git commit -m "chore: schema-refactor follow-up cleanup"
```

---

## Self-Review Notes

**Spec coverage:** All three picked items (FileType consolidation, withJsonSchema adapter, inputSchemaAugment wire-up) have dedicated tasks. The two skipped items (CursorSchema comment, ContinuationSchema.args type) are intentional and called out in the upstream review.

**Type consistency:** `FileType` is one Zod schema + one inferred type, exported under one name from `src/schema.ts`. `withJsonSchema` returns `StandardSchemaWithJSON<z.infer<T>, z.infer<T>>` and is used in both `registerTool` and `registerToolTask` call sites. The `DefinedTool.inputSchema/outputSchema` projection retains the existing `Tool['inputSchema']` cast so the public contract is unchanged.

**No placeholders:** Every code block above is complete and copy-pasteable; no `TODO`, no "similar to above", no "implement appropriately."

**Risk:** the only behavioural change observable to clients is the `read` tool's `tools/list` now carrying `allOf` mutex constraints. That's the intended outcome and is locked in by the new `json-schema.test.ts` assertions plus the regenerated snapshot.
