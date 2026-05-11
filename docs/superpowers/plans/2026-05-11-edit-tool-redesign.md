# Edit Tool Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-file `edit` tool with a unified single + multi-file (≤5) `edit` tool, and remove the now-redundant `diff_files` and `apply_patch` tools.

**Architecture:** One file ([src/tools/edit.ts](src/tools/edit.ts)) accepting exactly one of `path` / `paths[]` / `files[]`. Reuses today's match/apply primitives; adds a parallel per-file runner that returns tagged `{kind: 'ok' | 'failed', ...}` results. Best-effort failure isolation via `processInParallel`. Two tools removed atomically with all references.

**Tech Stack:** TypeScript, Zod v4 (`z.toJSONSchema` via [src/schema.ts](src/schema.ts)), `node:test` + `tsx`, `@modelcontextprotocol/server` 2.0 alpha, jsdiff (worker-offloaded).

**Spec:** [docs/superpowers/specs/2026-05-11-edit-tool-redesign-design.md](docs/superpowers/specs/2026-05-11-edit-tool-redesign-design.md)

---

## File Map

**Create:**

- `src/tools/edit.ts` — new tool entrypoint (replaces `edit-file.ts`)

**Modify:**

- `src/tools.ts` — drop `apply-patch`/`diff-files`/`edit-file` imports, add `edit`
- `src/prompts.ts` — remove `compare-files` prompt (uses `diff_files`)
- `src/resources.ts` — drop `diff_files`/`apply_patch` from overview rows
- `__tests__/contract.test.ts` — tool count 16 → 14, remove removed names
- `__tests__/tools/read-write.test.ts` — drop `apply_patch` describe block; update edit summary assertions to new format
- `__tests__/security.test.ts` — drop `diff_files: rejects when both paths are missing`
- `__tests__/schemas/__snapshots__/tool-schemas.json` — regenerated snapshot

**Delete:**

- `src/tools/edit-file.ts`
- `src/tools/diff-files.ts`
- `src/tools/apply-patch.ts`
- `__tests__/tools/diff.test.ts`
- `__tests__/tools/task-mode.test.ts` (entire file — tests only `diff_files`/`apply_patch` task mode)
- `__tests__/tools/refinements.test.ts` (entire file — tests only `apply_patch` multi-file)
- `.github/tool-schemas-ref.json` entries for `apply_patch` + `diff_files` (regenerated)

**Test (new):**

- `__tests__/tools/edit-multi.test.ts` — multi-file shapes, cap enforcement, failure isolation, summary format

---

## Pre-flight

- [ ] **Step 0.1: Confirm clean working tree on branch `dev`**

Run:

```pwsh
git status --short
```

Expected: empty output (or only the committed spec). If dirty, stash or commit first.

- [ ] **Step 0.2: Capture baseline test count**

Run:

```pwsh
npm run test 2>&1 | Select-String "tests" | Select-Object -Last 3
```

Note the totals. Used later to confirm we didn't accidentally regress.

---

## Task 1: Define the new `edit` schema (test-first)

**Files:**

- Create: `__tests__/tools/edit-multi.test.ts`
- Create: `src/tools/edit.ts`
- Modify: `src/tools.ts`

This task wires the new shape end-to-end with schema-validation tests only. Later tasks add behavior tests.

- [ ] **Step 1.1: Write failing schema-validation tests**

Create `__tests__/tools/edit-multi.test.ts`:

```ts
/**
 * Integration tests for the unified edit tool: single, paths[], files[].
 */
import { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

describe('edit tool — input validation', () => {
  let env: TestEnv;
  let client: Client;
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'edit-multi-'));
    env = await createTestEnv({ extraRoots: [tmpRoot] });
    client = env.client;
  });

  after(async () => {
    await env.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('rejects when none of path/paths/files is provided', async () => {
    const res = await client.callTool({
      name: 'edit',
      arguments: { edits: [{ oldText: 'a', newText: 'b' }] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both path and paths are provided', async () => {
    const res = await client.callTool({
      name: 'edit',
      arguments: {
        path: join(tmpRoot, 'x.txt'),
        paths: [join(tmpRoot, 'y.txt')],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both path and files are provided', async () => {
    const res = await client.callTool({
      name: 'edit',
      arguments: {
        path: join(tmpRoot, 'x.txt'),
        files: [{ path: join(tmpRoot, 'y.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects paths[] with more than 5 entries', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => join(tmpRoot, `f${i}.txt`));
    const res = await client.callTool({
      name: 'edit',
      arguments: { paths, edits: [{ oldText: 'a', newText: 'b' }] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects files[] with more than 5 entries', async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: join(tmpRoot, `f${i}.txt`),
      edits: [{ oldText: 'a', newText: 'b' }],
    }));
    const res = await client.callTool({ name: 'edit', arguments: { files } });
    assert.equal(res.isError, true);
  });
});
```

- [ ] **Step 1.2: Run the new test, watch it fail**

Run:

```pwsh
node --test --import tsx/esm "__tests__/tools/edit-multi.test.ts"
```

Expected: failures because `edit` still rejects the new arg shapes via its old schema.

- [ ] **Step 1.3: Scaffold `src/tools/edit.ts` with new schema**

Create `src/tools/edit.ts` by copying the current `src/tools/edit-file.ts` verbatim, then replace the input/output schema block (lines 25–67 of the original) with:

```ts
const EditSpecSchema = z.strictObject({
  oldText: z
    .string()
    .min(1, 'oldText required')
    .describe('Exact text to find (must match literally)')
    .meta({ examples: ['const x = 1;', 'function oldName('] }),
  newText: z
    .string()
    .describe('Replacement text (empty string to delete)')
    .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
});

const FileEditEntrySchema = z.strictObject({
  path: RequiredPath.describe('File path'),
  edits: z.array(EditSpecSchema).min(1).describe('Edits for this file'),
});

const MAX_MULTI_FILES = 5;

const EditFileInputSchema = z
  .strictObject({
    path: RequiredPath.optional().describe('File path (single-file mode)'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(MAX_MULTI_FILES)
      .optional()
      .describe(`File paths; same edits applied to each (max ${MAX_MULTI_FILES})`),
    files: z
      .array(FileEditEntrySchema)
      .min(1)
      .max(MAX_MULTI_FILES)
      .optional()
      .describe(`Per-file edits (max ${MAX_MULTI_FILES})`),
    edits: z
      .array(EditSpecSchema)
      .min(1)
      .optional()
      .describe('Edits applied to path or every entry in paths'),
    dryRun: defaultFalseBoolean('Preview changes without writing'),
    ignoreWhitespace: defaultFalseBoolean('Ignore leading/trailing whitespace when matching'),
  })
  .superRefine((value, ctx) => {
    const modes = [value.path !== undefined, value.paths !== undefined, value.files !== undefined];
    const provided = modes.filter(Boolean).length;
    if (provided === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Provide exactly one of 'path', 'paths', or 'files'",
        input: value,
      });
      return;
    }
    if (provided > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Use only one of 'path', 'paths', or 'files'",
        input: value,
      });
      return;
    }
    if ((value.path !== undefined || value.paths !== undefined) && value.edits === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' required when using 'path' or 'paths'",
        input: value,
      });
    }
    if (value.files !== undefined && value.edits !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['edits'],
        message: "'edits' not allowed with 'files'; each file carries its own edits",
        input: value,
      });
    }
  });

const PerFileResultSchema = z.strictObject({
  path: z.string().describe('File path'),
  size: NonNegInt.describe('File size in bytes'),
  lineCount: NonNegInt.describe('Number of lines'),
  mimeType: z.string().describe('MIME type'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).describe('File kind'),
  resourceUri: z.string().describe('Resource URI'),
  modified: IsoDateTime.describe('Modified (ISO 8601 UTC)'),
  appliedEdits: NonNegInt.describe('Edits applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  diff: z.string().optional().describe('Unified diff (dryRun or when changes present)'),
  unmatchedEdits: z.array(z.string()).optional().describe('oldText with no match'),
  lineRange: z.tuple([PositiveInt, PositiveInt]).optional().describe('[firstLine, lastLine]'),
});

const EditFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  // Single-file fields
  path: z.string().optional().describe('File path (single-file mode)'),
  size: NonNegInt.optional().describe('File size in bytes'),
  lineCount: NonNegInt.optional().describe('Number of lines'),
  mimeType: z.string().optional().describe('MIME type'),
  kind: z.enum(['text', 'binary', 'image', 'audio', 'pdf']).optional().describe('File kind'),
  resourceUri: z.string().optional().describe('Resource URI'),
  modified: IsoDateTime.optional().describe('Modified (ISO 8601 UTC)'),
  appliedEdits: NonNegInt.optional().describe('Edits applied'),
  linesAdded: NonNegInt.optional().describe('Lines added'),
  linesRemoved: NonNegInt.optional().describe('Lines removed'),
  diff: z.string().optional().describe('Unified diff of changes'),
  unmatchedEdits: z.array(z.string()).optional().describe('oldText with no match'),
  lineRange: z.tuple([PositiveInt, PositiveInt]).optional().describe('[firstLine, lastLine]'),
  // Multi-file fields
  results: z.array(PerFileResultSchema).optional().describe('Per-file successes (multi mode)'),
  failures: z
    .array(z.strictObject({ path: z.string(), error: PerFileErrorSchema }))
    .optional()
    .describe('Per-file hard failures (multi mode)'),
  summary: OperationSummarySchema.optional().describe('Aggregate counts (multi mode)'),
});
```

Also add the new imports at the top of the file:

```ts
import { processInParallel } from '../core/concurrency.js';
import { OperationSummarySchema, PerFileErrorSchema } from '../schema.js';
```

And remove the (now unused) imports that were specific to the old single-file shape (none — they all stay).

For now, leave `handleEditFile` and `defineTool` untouched. Update `defineTool` config:

- `name: 'edit'`
- `title: 'Edit Files'`
- description (replace existing):

  ```text
  Apply sequential literal string replacements to one or more files (max 5).
  Single-file: { path, edits }.
  Multi-file shared: { paths, edits } — same edits applied to each file.
  Multi-file per-file: { files: [{ path, edits }, …] }.
  `oldText` must match exactly — include 3–5 lines of context. Use `dryRun:true` to preview.
  For glob-driven bulk regex replacement, use `replace_text` instead.
  ```

At the bottom of the file, also export under the original symbol name so other modules keep compiling temporarily:

```ts
export const EDIT_FILE = EDIT;
```

(Will be removed in Task 6.)

- [ ] **Step 1.4: Wire it into `src/tools.ts`**

Edit `src/tools.ts`:

Replace

```ts
import './tools/edit-file.js';
```

with

```ts
import './tools/edit.js';
```

(Leave `apply-patch` and `diff-files` imports for now — removed in Task 5.)

- [ ] **Step 1.5: Delete the old file**

```pwsh
git rm src/tools/edit-file.ts
```

- [ ] **Step 1.6: Type-check + run new validation tests**

```pwsh
npm run type-check
node --test --import tsx/esm "__tests__/tools/edit-multi.test.ts"
```

Expected: type-check passes; all 5 validation tests pass.

- [ ] **Step 1.7: Commit**

```pwsh
git add -A
git commit -m "feat(edit): introduce unified single/multi-file input schema"
```

---

## Task 2: Per-file runner that returns tagged results

The current `handleEditFile` writes through to the response. We need an inner runner that returns a tagged `{kind: 'ok', result: PerFileResult, link?: ResourceLink}` or `{kind: 'failed', path, error}` so the dispatcher can aggregate.

**Files:**

- Modify: `src/tools/edit.ts`

- [ ] **Step 2.1: Add the runner type and function**

Inside `src/tools/edit.ts`, just above `handleEditFile`, add:

```ts
type PerFileResult = z.infer<typeof PerFileResultSchema>;

type RunOneFileResult =
  | {
      kind: 'ok';
      path: string;
      result: PerFileResult;
      link?: ReturnType<typeof putResource>['link'];
    }
  | {
      kind: 'failed';
      path: string;
      error: { code: string; message: string; suggestion?: string };
    };

async function runOneFile(
  filePath: string,
  edits: EditInput['edits'],
  dryRun: boolean,
  ignoreWhitespace: boolean,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<RunOneFileResult> {
  try {
    const { validPath, content } = await loadEditableFile(filePath, pathGuard, signal);
    const editResult = await applyEdits(content, edits ?? [], ignoreWhitespace);

    if (dryRun && editResult.appliedEdits > 0) {
      editResult.diff = await buildDiff(validPath, content, editResult.content);
    }

    if (!dryRun && editResult.appliedEdits > 0) {
      await atomicWriteFile(validPath, editResult.content, { encoding: 'utf-8', signal });
      Logger.info(
        `edit: ${filePath} (${editResult.appliedEdits} edits, +${editResult.linesAdded}/-${editResult.linesRemoved})`,
      );
    }

    const fileStats =
      !dryRun && editResult.appliedEdits > 0 ? await withAbort(stat(validPath), signal) : undefined;
    const bytesWritten = Buffer.byteLength(editResult.content, 'utf-8');
    const lineCount = editResult.content.split('\n').length;
    const mimeInfo = detectMimeType(validPath, Buffer.from(editResult.content.slice(0, 512)));

    let resourceUri = '';
    let resourceLink: ReturnType<typeof putResource>['link'] | undefined;
    if (editResult.appliedEdits > 0 && resourceStore) {
      const { entry, link } = putResource({
        store: resourceStore,
        name: basename(validPath),
        mimeType: mimeInfo.mimeType,
        kind: mimeInfo.kind,
        content: editResult.content,
      });
      resourceUri = entry.uri;
      resourceLink = link;
    }

    const result: PerFileResult = {
      path: validPath,
      size: bytesWritten,
      lineCount,
      mimeType: mimeInfo.mimeType,
      kind: mimeInfo.kind,
      resourceUri,
      modified: (fileStats?.mtime ?? new Date()).toISOString(),
      appliedEdits: editResult.appliedEdits,
      ...(editResult.appliedEdits > 0
        ? { linesAdded: editResult.linesAdded, linesRemoved: editResult.linesRemoved }
        : {}),
      ...(editResult.unmatchedEdits.length > 0
        ? { unmatchedEdits: editResult.unmatchedEdits }
        : {}),
      ...(editResult.diff ? { diff: editResult.diff } : {}),
      ...(editResult.lineRange ? { lineRange: editResult.lineRange } : {}),
    };

    return resourceLink
      ? { kind: 'ok', path: validPath, result, link: resourceLink }
      : { kind: 'ok', path: validPath, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof McpError ? error.code : ErrorCode.UNKNOWN;
    return {
      kind: 'failed',
      path: filePath,
      error: { code: String(code), message },
    };
  }
}
```

- [ ] **Step 2.2: Type-check**

```pwsh
npm run type-check
```

Expected: passes. The new function is not yet wired into `run:`.

- [ ] **Step 2.3: Commit**

```pwsh
git add -A
git commit -m "feat(edit): add tagged per-file runner"
```

---

## Task 3: Multi-file dispatcher + summary formatter (test-first)

**Files:**

- Modify: `__tests__/tools/edit-multi.test.ts`
- Modify: `src/tools/edit.ts`

- [ ] **Step 3.1: Add behavior tests**

Append to `__tests__/tools/edit-multi.test.ts`:

```ts
describe('edit tool — paths[] shared edits', () => {
  let env: TestEnv;
  let client: Client;
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'edit-shared-'));
    env = await createTestEnv({ extraRoots: [tmpRoot] });
    client = env.client;
  });

  after(async () => {
    await env.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('applies the same edit to every file', async () => {
    const a = join(tmpRoot, 'a.txt');
    const b = join(tmpRoot, 'b.txt');
    await writeFile(a, 'hello world\n');
    await writeFile(b, 'hello world\n');

    const res = await client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, b],
        edits: [{ oldText: 'hello', newText: 'goodbye' }],
      },
    });
    assertOk(res);
    const out = getStructured<{
      results: { path: string; appliedEdits: number }[];
      summary: { total: number; succeeded: number; failed: number };
    }>(res);

    assert.equal(out.summary.total, 2);
    assert.equal(out.summary.succeeded, 2);
    assert.equal(out.summary.failed, 0);
    assert.equal(out.results.length, 2);
    assert.equal((await readFile(a, 'utf-8')).trim(), 'goodbye world');
    assert.equal((await readFile(b, 'utf-8')).trim(), 'goodbye world');
  });

  it('records NO MATCH files in results with unmatchedEdits, not failures', async () => {
    const a = join(tmpRoot, 'm-a.txt');
    const b = join(tmpRoot, 'm-b.txt');
    await writeFile(a, 'hello\n');
    await writeFile(b, 'other\n');

    const res = await client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, b],
        edits: [{ oldText: 'hello', newText: 'hi' }],
      },
    });
    assertOk(res);
    const out = getStructured<{
      results: { path: string; appliedEdits: number; unmatchedEdits?: string[] }[];
      failures?: { path: string }[];
      summary: { total: number; succeeded: number; failed: number };
    }>(res);
    assert.equal(out.summary.failed, 0);
    assert.equal(out.results.length, 2);
    const byPath = new Map(out.results.map((r) => [r.path, r]));
    assert.equal(byPath.get(a)!.appliedEdits, 1);
    assert.equal(byPath.get(b)!.appliedEdits, 0);
    assert.deepEqual(byPath.get(b)!.unmatchedEdits, ['hello']);
  });

  it('isolates hard failures into failures[]', async () => {
    const a = join(tmpRoot, 'iso-a.txt');
    await writeFile(a, 'hello\n');
    const missing = join(tmpRoot, 'does-not-exist.txt');

    const res = await client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, missing],
        edits: [{ oldText: 'hello', newText: 'hi' }],
      },
    });
    assertOk(res);
    const out = getStructured<{
      results: { path: string }[];
      failures: { path: string; error: { code: string; message: string } }[];
      summary: { total: number; succeeded: number; failed: number };
    }>(res);
    assert.equal(out.summary.total, 2);
    assert.equal(out.summary.succeeded, 1);
    assert.equal(out.summary.failed, 1);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0]!.path, missing);
    assert.equal((await readFile(a, 'utf-8')).trim(), 'hi');
  });

  it('summary text follows "edit: name +A -B · name FAILED (n/N ok)" format', async () => {
    const a = join(tmpRoot, 's-a.txt');
    await writeFile(a, 'one\n');
    const missing = join(tmpRoot, 's-missing.txt');

    const res = await client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, missing],
        edits: [{ oldText: 'one', newText: 'two' }],
      },
    });
    assertOk(res);
    const text = (res.content?.[0] as { text: string }).text;
    assert.match(text, /^edit: s-a\.txt \+\d+ -\d+ · s-missing\.txt FAILED \(1\/2 ok\)/u);
  });
});

describe('edit tool — files[] per-file edits', () => {
  let env: TestEnv;
  let client: Client;
  let tmpRoot: string;

  before(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'edit-perfile-'));
    env = await createTestEnv({ extraRoots: [tmpRoot] });
    client = env.client;
  });

  after(async () => {
    await env.cleanup();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('applies independent edits to each file', async () => {
    const a = join(tmpRoot, 'pf-a.txt');
    const b = join(tmpRoot, 'pf-b.txt');
    await writeFile(a, 'apple\n');
    await writeFile(b, 'banana\n');

    const res = await client.callTool({
      name: 'edit',
      arguments: {
        files: [
          { path: a, edits: [{ oldText: 'apple', newText: 'APPLE' }] },
          { path: b, edits: [{ oldText: 'banana', newText: 'BANANA' }] },
        ],
      },
    });
    assertOk(res);
    assert.equal((await readFile(a, 'utf-8')).trim(), 'APPLE');
    assert.equal((await readFile(b, 'utf-8')).trim(), 'BANANA');
  });

  it('dryRun writes nothing and still populates diff', async () => {
    const a = join(tmpRoot, 'dry-a.txt');
    await writeFile(a, 'foo\n');

    const res = await client.callTool({
      name: 'edit',
      arguments: {
        dryRun: true,
        files: [{ path: a, edits: [{ oldText: 'foo', newText: 'bar' }] }],
      },
    });
    assertOk(res);
    const out = getStructured<{ results: { diff?: string; appliedEdits: number }[] }>(res);
    assert.equal(out.results[0]!.appliedEdits, 1);
    assert.ok(out.results[0]!.diff && out.results[0]!.diff.includes('-foo'));
    assert.equal((await readFile(a, 'utf-8')).trim(), 'foo'); // unchanged
  });
});
```

- [ ] **Step 3.2: Run the new tests, watch them fail**

```pwsh
node --test --import tsx/esm "__tests__/tools/edit-multi.test.ts"
```

Expected: validation tests still pass; behavior tests fail (no dispatcher yet).

- [ ] **Step 3.3: Implement the dispatcher**

In `src/tools/edit.ts`, replace the existing `handleEditFile` and `run:` body with the new dispatch. Place the following helpers just below `runOneFile`:

```ts
function basenameToken(path: string): string {
  return basename(path);
}

function formatFileToken(entry: RunOneFileResult): string {
  const name = basenameToken(entry.path);
  if (entry.kind === 'failed') return `${name} FAILED`;
  const r = entry.result;
  if (r.appliedEdits === 0) return `${name} NO MATCH`;
  return `${name} +${r.linesAdded ?? 0} -${r.linesRemoved ?? 0}`;
}

function formatMultiSummary(entries: RunOneFileResult[]): string {
  const ok = entries.filter((e) => e.kind === 'ok' && (e.result.appliedEdits ?? 0) > 0).length;
  const tokens = entries.map(formatFileToken);
  const tail = ok === entries.length ? '' : ` (${ok}/${entries.length} ok)`;
  return `edit: ${tokens.join(' · ')}${tail}`;
}

function formatSingleSummary(result: PerFileResult): string {
  const name = basenameToken(result.path);
  const sizeFragment = ` · ${formatBytes(result.size)} · ${String(result.lineCount)} lines`;
  if (result.appliedEdits === 0) {
    return `edit: ${name} NO MATCH${sizeFragment}`;
  }
  return `edit: ${name} +${result.linesAdded ?? 0} -${result.linesRemoved ?? 0}${sizeFragment}`;
}

interface FileJob {
  path: string;
  edits: EditInput['edits'];
}

function normalizeJobs(args: EditInput): FileJob[] {
  if (args.path !== undefined) return [{ path: args.path, edits: args.edits ?? [] }];
  if (args.paths !== undefined)
    return args.paths.map((p) => ({ path: p, edits: args.edits ?? [] }));
  if (args.files !== undefined) return args.files.map((f) => ({ path: f.path, edits: f.edits }));
  throw new McpError(ErrorCode.INVALID_INPUT, 'no edit target', '');
}

async function dispatch(
  args: EditInput,
  pathGuard: PathGuard,
  resourceStore: ResourceStore | undefined,
  signal?: AbortSignal,
): Promise<{
  text: string;
  structured: EditOutput;
  links: ReturnType<typeof putResource>['link'][];
}> {
  const jobs = normalizeJobs(args);
  const { results } = await processInParallel(
    jobs.map((job, index) => ({ job, index })),
    async ({ job }) =>
      runOneFile(
        job.path,
        job.edits,
        args.dryRun ?? false,
        args.ignoreWhitespace ?? false,
        pathGuard,
        resourceStore,
        signal,
      ),
    PARALLEL_CONCURRENCY,
    signal,
  );

  // Preserve input order
  const ordered = jobs.map((_, index) => results[index]!);

  // Single-file response
  if (args.path !== undefined) {
    const entry = ordered[0]!;
    if (entry.kind === 'failed') {
      throw new McpError(ErrorCode.UNKNOWN, entry.error.message, entry.path);
    }
    const r = entry.result;
    const structured: EditOutput = {
      ok: true as const,
      path: r.path,
      size: r.size,
      lineCount: r.lineCount,
      mimeType: r.mimeType,
      kind: r.kind,
      resourceUri: r.resourceUri,
      modified: r.modified,
      appliedEdits: r.appliedEdits,
      ...(r.linesAdded !== undefined ? { linesAdded: r.linesAdded } : {}),
      ...(r.linesRemoved !== undefined ? { linesRemoved: r.linesRemoved } : {}),
      ...(r.diff ? { diff: r.diff } : {}),
      ...(r.unmatchedEdits ? { unmatchedEdits: r.unmatchedEdits } : {}),
      ...(r.lineRange ? { lineRange: r.lineRange } : {}),
    };
    if (r.appliedEdits === 0 && r.unmatchedEdits && r.unmatchedEdits.length > 0) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        `All ${r.unmatchedEdits.length} edits failed. Verify oldText matches exact file content.`,
        r.path,
      );
    }
    return {
      text: formatSingleSummary(r),
      structured,
      links: entry.link ? [entry.link] : [],
    };
  }

  // Multi-file response
  const okEntries = ordered.flatMap((e) => (e.kind === 'ok' ? [e] : []));
  const failedEntries = ordered.flatMap((e) => (e.kind === 'failed' ? [e] : []));
  const structured: EditOutput = {
    ok: true as const,
    results: okEntries.map((e) => e.result),
    ...(failedEntries.length > 0
      ? {
          failures: failedEntries.map((e) => ({
            path: e.path,
            error: {
              code: e.error.code,
              message: e.error.message,
              ...(e.error.suggestion ? { suggestion: e.error.suggestion } : {}),
            },
          })),
        }
      : {}),
    summary: {
      total: ordered.length,
      succeeded: okEntries.length,
      failed: failedEntries.length,
    },
  };
  const links = okEntries.flatMap((e) => (e.link ? [e.link] : []));
  return { text: formatMultiSummary(ordered), structured, links };
}
```

Now replace the `defineTool({...})` `run` body:

```ts
  run: async (args, ctx) => {
    const { text, structured, links } = await dispatch(
      args,
      ctx.pathGuard,
      ctx.resourceStore,
      ctx.signal,
    );
    ctx.log?.('info', text, 'edit');
    if (links.length > 0) {
      return buildResourceResponse({
        summary: text,
        resources: links,
        structured,
      });
    }
    return buildToolResponse(text, structured);
  },
```

Also delete the now-unused `handleEditFile` and `buildStructuredEditOutput` functions.

Update `progressLabel` to handle all three input shapes:

```ts
function buildEditProgressMessage(args: EditInput): string {
  const tag = args.dryRun ? ' [dry run]' : '';
  if (args.path !== undefined) return `Edit File: ${basename(args.path)}${tag}`;
  if (args.paths !== undefined) return `Edit Files: ${args.paths.length} files${tag}`;
  if (args.files !== undefined) return `Edit Files: ${args.files.length} files${tag}`;
  return `Edit Files${tag}`;
}
```

- [ ] **Step 3.4: Run the new edit-multi tests**

```pwsh
node --test --import tsx/esm "__tests__/tools/edit-multi.test.ts"
```

Expected: all tests pass.

- [ ] **Step 3.5: Type-check**

```pwsh
npm run type-check
```

Expected: passes.

- [ ] **Step 3.6: Commit**

```pwsh
git add -A
git commit -m "feat(edit): implement multi-file dispatch with per-file results"
```

---

## Task 4: Update existing single-file edit tests for new summary format

The existing read-write test asserts `summary.includes('edit-file:')`. New format starts with `edit:`.

**Files:**

- Modify: `__tests__/tools/read-write.test.ts`

- [ ] **Step 4.1: Update summary assertions**

Open `__tests__/tools/read-write.test.ts`. Find each occurrence of:

```ts
assert.ok(summary.includes('edit-file:'));
```

Replace with:

```ts
assert.ok(summary.startsWith('edit:'));
```

Also update the preceding comment from `// Verify summary includes "edit-file:"` to `// Verify summary starts with "edit:"`.

- [ ] **Step 4.2: Run edit tests**

```pwsh
node --test --import tsx/esm "__tests__/tools/read-write.test.ts"
```

Expected: edit-related tests pass. `apply_patch` tests still pass (they're untouched until Task 5).

- [ ] **Step 4.3: Commit**

```pwsh
git add -A
git commit -m "test(edit): align summary assertions with new format"
```

---

## Task 5: Remove `apply_patch` and `diff_files`

**Files:**

- Delete: `src/tools/apply-patch.ts`
- Delete: `src/tools/diff-files.ts`
- Delete: `__tests__/tools/diff.test.ts`
- Delete: `__tests__/tools/task-mode.test.ts`
- Delete: `__tests__/tools/refinements.test.ts`
- Modify: `src/tools.ts`
- Modify: `src/prompts.ts`
- Modify: `src/resources.ts`
- Modify: `__tests__/contract.test.ts`
- Modify: `__tests__/tools/read-write.test.ts`
- Modify: `__tests__/tools/hash.test.ts`
- Modify: `__tests__/security.test.ts`
- Modify: `__tests__/prompts.test.ts`

- [ ] **Step 5.1: Delete the tool source files**

```pwsh
git rm src/tools/apply-patch.ts src/tools/diff-files.ts
```

- [ ] **Step 5.2: Delete tool-specific test files**

```pwsh
git rm __tests__/tools/diff.test.ts __tests__/tools/task-mode.test.ts __tests__/tools/refinements.test.ts
```

- [ ] **Step 5.3: Remove imports from `src/tools.ts`**

Delete these two lines:

```ts
import './tools/apply-patch.js';
import './tools/diff-files.js';
```

- [ ] **Step 5.4: Update `src/resources.ts` tool overview**

Find:

```ts
    ['Read', pickAvailableToolNames(['read', 'diff_files'])],
    [
      'Write',
      pickAvailableToolNames([
        'make_dir',
        'write',
        'edit',
        'move',
        'delete',
        'apply_patch',
        'replace_text',
      ]),
    ],
```

Replace with:

```ts
    ['Read', pickAvailableToolNames(['read'])],
    [
      'Write',
      pickAvailableToolNames([
        'make_dir',
        'write',
        'edit',
        'move',
        'delete',
        'replace_text',
      ]),
    ],
```

- [ ] **Step 5.5: Remove the `compare-files` prompt from `src/prompts.ts`**

Open `src/prompts.ts`. Delete the entire `COMPARE_FILES` constant (the `const COMPARE_FILES: PromptEntry = { ... };` block) and remove its registration from any `PROMPTS`/array export at the bottom of the file. Run `grep_search` for `COMPARE_FILES` in `src/` to confirm no dangling references.

- [ ] **Step 5.6: Update `__tests__/prompts.test.ts`**

Find the test that asserts `m0.content.text` matches `/Call`diff_files`/u` and delete the entire `it(...)` (or `describe(...)`) block containing it. If a `describe('compare-files prompt', () => {...})` exists, delete the whole describe.

- [ ] **Step 5.7: Update `__tests__/contract.test.ts`**

Replace the file's tool sets:

`ALL_TOOLS`:

```ts
const ALL_TOOLS = new Set([
  'hash_file',
  'make_dir',
  'delete',
  'edit',
  'ls',
  'move',
  'read',
  'replace_text',
  'list_roots',
  'search_text',
  'find_files',
  'stat',
  'tree',
  'write',
]);
```

`READ_ONLY_TOOLS`:

```ts
const READ_ONLY_TOOLS = new Set([
  'hash_file',
  'ls',
  'read',
  'list_roots',
  'search_text',
  'find_files',
  'stat',
  'tree',
]);
```

`DESTRUCTIVE_TOOLS`:

```ts
const DESTRUCTIVE_TOOLS = new Set(['edit', 'delete', 'move', 'replace_text', 'write']);
```

Also update the header comment from `all 16 tools` to `all 14 tools`. Search for any other occurrence of `'apply_patch'` or `'diff_files'` in the file (around line 181/183) and delete those entries from whichever set they're in.

- [ ] **Step 5.8: Drop the `apply_patch` describe block from `__tests__/tools/read-write.test.ts`**

Find the comment `// ─── apply_patch ──────────────...` and the following `describe('apply_patch tool', () => { ... })` block. Delete the whole describe (everything from `// ─── apply_patch ───` to its closing `});`). Update the file's top comment from

```text
* Integration tests for file I/O tools: read, write, read_many, edit, apply_patch.
```

to

```text
* Integration tests for file I/O tools: read, write, read_many, edit.
```

- [ ] **Step 5.9: Drop the `diff_files tool` describe block from `__tests__/tools/hash.test.ts`**

Find `describe('diff_files tool', () => { ... })`. Delete the whole describe block. Update the top comment:

```text
* Integration tests for calculate_hash and diff_files tools.
```

to

```text
* Integration tests for calculate_hash tool.
```

- [ ] **Step 5.10: Drop `diff_files: rejects when both paths are missing` from `__tests__/security.test.ts`**

Find the `it('diff_files: rejects when both paths are missing', ...)` block and delete it.

- [ ] **Step 5.11: Type-check**

```pwsh
npm run type-check
```

Expected: passes. If a stale `EDIT_FILE` symbol is referenced anywhere outside `src/tools/edit.ts`, fix it (Task 6 removes the temporary alias).

- [ ] **Step 5.12: Run lint to catch unused imports**

```pwsh
npm run lint
```

Expected: zero warnings. Fix any unused imports flagged in `src/prompts.ts` and elsewhere from the removed prompt.

- [ ] **Step 5.13: Run full test suite**

```pwsh
npm run test
```

Expected: all remaining tests pass. Schema snapshot test will fail — that's Task 7.

- [ ] **Step 5.14: Commit**

```pwsh
git add -A
git commit -m "feat: remove apply_patch and diff_files tools (replaced by edit)"
```

---

## Task 6: Remove the temporary `EDIT_FILE` alias

**Files:**

- Modify: `src/tools/edit.ts`

- [ ] **Step 6.1: Delete the alias**

In `src/tools/edit.ts`, remove the line:

```ts
export const EDIT_FILE = EDIT;
```

- [ ] **Step 6.2: Confirm no callers**

```pwsh
grep_search EDIT_FILE
```

(Or `npm run type-check`.) Expected: no references in `src/` or `__tests__/`. Fix if any remain.

- [ ] **Step 6.3: Commit**

```pwsh
git add -A
git commit -m "chore(edit): drop temporary EDIT_FILE alias"
```

---

## Task 7: Regenerate schema snapshot

**Files:**

- Modify: `__tests__/schemas/__snapshots__/tool-schemas.json`
- Modify: `.github/tool-schemas-ref.json`

- [ ] **Step 7.1: Run snapshot test to confirm it fails**

```pwsh
node --test --import tsx/esm "__tests__/schemas/snapshot.test.ts"
```

Expected: failure (snapshot has 16 tools including `apply_patch` and `diff_files`, runtime has 14 and a different `edit` schema).

- [ ] **Step 7.2: Update the snapshot**

Run with snapshot-update flag (check `package.json` / `__tests__/schemas/snapshot.test.ts` for the env var). Typically:

```pwsh
$env:UPDATE_SNAPSHOTS = "1"; node --test --import tsx/esm "__tests__/schemas/snapshot.test.ts"; Remove-Item Env:UPDATE_SNAPSHOTS
```

If the project uses a different mechanism, open `__tests__/schemas/snapshot.test.ts`, find the snapshot-update hook, and follow whatever convention it uses (e.g., delete the snapshot file and re-run).

- [ ] **Step 7.3: Re-run snapshot test**

```pwsh
node --test --import tsx/esm "__tests__/schemas/snapshot.test.ts"
```

Expected: passes.

- [ ] **Step 7.4: Regenerate `.github/tool-schemas-ref.json`**

Check if there's a script (e.g., `scripts/check-mcp-types.mjs` or similar) that produces this file. Look in `package.json` scripts and at the file header. If a regen script exists, run it; otherwise mirror the updated snapshot manually by removing the `apply_patch` and `diff_files` entries and replacing the `edit` entry with the new shape.

```pwsh
Get-ChildItem scripts -File | Select-String -Pattern "tool-schemas-ref" -List
```

- [ ] **Step 7.5: Commit**

```pwsh
git add -A
git commit -m "test: refresh tool schema snapshot for edit redesign"
```

---

## Task 8: Documentation sweep

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

- [ ] **Step 8.1: Find every doc reference**

```pwsh
grep_search "apply_patch|diff_files|apply-patch|diff-files|edit-file"
```

Expected list of hits in `README.md`, `AGENTS.md`, `CLAUDE.md`, and any other `.md` files. Update each:

- Replace `18 tools` / `16 tools` counts with `14 tools` (verify the actual current count first by counting entries in `ALL_TOOLS` in `__tests__/contract.test.ts`).
- Remove rows/lines mentioning `apply_patch` or `diff_files` from any tool list.
- Replace any "diff_files → apply_patch" workflow descriptions with "edit (single or multi-file)".

- [ ] **Step 8.2: Sanity-grep**

```pwsh
grep_search "apply_patch|diff_files"
```

Expected: only matches inside the spec doc, the plan doc, and `.tasks-history.json` (which is historical and not edited).

- [ ] **Step 8.3: Commit**

```pwsh
git add -A
git commit -m "docs: drop apply_patch/diff_files references"
```

---

## Task 9: Final verification

- [ ] **Step 9.1: Full task runner**

```pwsh
node scripts/tasks.mjs
```

Expected: all stages green (format → lint, type-check, knip → test, rebuild).

- [ ] **Step 9.2: Confirm test count moved as expected**

Compare against the baseline from Step 0.2. Expected: total tests dropped by the count from `diff.test.ts` + `task-mode.test.ts` + `refinements.test.ts` + the deleted describe blocks, minus the new `edit-multi.test.ts` cases. Net change: roughly neutral.

- [ ] **Step 9.3: Manual smoke via dist build**

```pwsh
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 9.4: Final commit if anything was tweaked**

```pwsh
git status --short
```

If clean, done. Otherwise:

```pwsh
git add -A
git commit -m "chore: final cleanup after edit redesign"
```

---

## Self-Review Notes

**Spec coverage:**

- §2.1 Input shapes — Tasks 1, 3.
- §2.2 Output shape — Tasks 1, 2, 3.
- §2.3 Summary line — Tasks 3, 4.
- §3.1 Per-file processing — Task 2.
- §3.2 Failure isolation — Tasks 2, 3.
- §3.3 Match modes — Inherited from existing `applyEdits` (no change needed).
- §3.4 dryRun — Task 2 (`runOneFile`), test in Task 3.
- §3.5 Resource store — Task 2 (`runOneFile`), Task 3 (`dispatch` aggregates `links`).
- §4 File layout — Tasks 1, 2, 3, 6.
- §5 Removals — Tasks 5, 8.
- §6 Migration path — Documented in Task 1 description + Task 8 docs.
- §7 Testing — Tasks 1, 3, 4, 5, 7.

**Symbol consistency:** `EDIT` exported throughout; `EDIT_FILE` alias added in Task 1, removed in Task 6. `runOneFile`, `dispatch`, `normalizeJobs`, `formatMultiSummary`, `formatSingleSummary`, `formatFileToken`, `RunOneFileResult`, `PerFileResult`, `FileJob` names used consistently from definition (Task 2/3) onward.
