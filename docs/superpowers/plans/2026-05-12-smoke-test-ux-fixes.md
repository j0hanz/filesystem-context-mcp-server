# Smoke Test UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four tool UX issues surfaced by the smoke test: `replace_text` dryRun default, glob non-recursion, `delete` ok contract, and `replace_text` file-path handling.

**Architecture:** Four independent, targeted edits across three source files (`src/tools/replace-in-files.ts`, `src/tools/search-content.ts`, `src/tools/delete-file.ts`) and their corresponding integration tests. Each task is self-contained with a red-green-commit cycle. No backwards-compat shims.

**Tech Stack:** Node.js ESM, TypeScript (strict), Zod v4, fast-glob (`globEntries` wrapper), node:test integration tests.

---

## File map

| File                                | What changes                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/tools/replace-in-files.ts`     | `dryRun` default, `baseNameMatch`, file-path auto-detect + `globEscape`, description/gotchas |
| `src/tools/search-content.ts`       | `baseNameMatch` in `SEARCH_CONTENT_DEFAULTS`, gotcha                                         |
| `src/tools/delete-file.ts`          | `ok` schema type, `ok` computation, gotcha                                                   |
| `__tests__/tools/search.test.ts`    | New tests for Tasks 1, 2, 3, 5                                                               |
| `__tests__/tools/directory.test.ts` | Updated + new assertions for Task 4                                                          |

---

## Task 1 — `replace_text`: flip `dryRun` default to `false`

**Files:**

- Modify: `src/tools/replace-in-files.ts:62-65` (schema field), `:608-613` (tool description)
- Modify: `__tests__/tools/search.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('search_and_replace tool', ...)` block in `__tests__/tools/search.test.ts`, after the existing `'dryRun:true does not modify any files'` test:

```typescript
it('applies changes when dryRun is omitted (default is false)', async () => {
  const file = join(env.tmpDir, 'default-dry.txt');
  await writeFile(file, 'before\n', 'utf8');
  const raw = await env.client.callTool({
    name: 'replace_text',
    arguments: {
      path: env.tmpDir,
      pattern: 'default-dry.txt',
      searchPattern: 'before',
      replacement: 'after',
      // dryRun intentionally omitted — must default to false
    },
  });
  assertOk(raw);
  const actual = await readFile(file, 'utf8');
  assert.equal(actual, 'after\n', 'Omitting dryRun should apply changes (default false)');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node scripts/tasks.mjs test --name-pattern "applies changes when dryRun is omitted"
```

Expected: FAIL — file still contains `'before\n'` because current default is `true`.

- [ ] **Step 3: Change the default in the schema**

In `src/tools/replace-in-files.ts`, line 61–65:

```typescript
// BEFORE
dryRun: z
  .boolean()
  .optional()
  .default(true)
  .describe('Preview without writing — set false to apply'),

// AFTER
dryRun: z
  .boolean()
  .optional()
  .default(false)
  .describe('Apply changes immediately. Set true to preview without writing.'),
```

- [ ] **Step 4: Update the tool description**

In `src/tools/replace-in-files.ts`, find the `defineTool` call (around line 605). Update `description`:

```typescript
// BEFORE
description:
  'Bulk search-and-replace across files matching a glob. ' +
  'Replaces ALL occurrences per file (unlike `edit`: first only). ' +
  'Always `dryRun:true` first — returns a unified diff. ' +
  'Literal matching by default; `isRegex:true` enables RE2 with capture groups ($1, $2).',

// AFTER
description:
  'Bulk search-and-replace across files matching a glob. ' +
  'Replaces ALL occurrences per file (unlike `edit`: first only). ' +
  'Use `returnDiff:true` to preview changes as a unified diff before or alongside writing. ' +
  'Literal matching by default; `isRegex:true` enables RE2 with capture groups ($1, $2).',
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
node scripts/tasks.mjs test --name-pattern "applies changes when dryRun is omitted"
```

Expected: PASS.

- [ ] **Step 6: Run the full search test suite to check no regressions**

```bash
node --test --import tsx/esm "__tests__/tools/search.test.ts"
```

Expected: all tests pass. The existing `'dryRun:true does not modify any files'` test passes because it still explicitly sets `dryRun: true`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/replace-in-files.ts __tests__/tools/search.test.ts
git commit -m "fix(replace_text): default dryRun to false, apply changes immediately"
```

---

## Task 2 — `replace_text`: `baseNameMatch: true` for recursive glob

**Files:**

- Modify: `src/tools/replace-in-files.ts` (`globEntries` options)
- Modify: `__tests__/tools/search.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Add this test inside `describe('search_and_replace tool', ...)` in `__tests__/tools/search.test.ts`:

```typescript
it('pattern without / matches files in subdirectories (baseNameMatch)', async () => {
  const sub = join(env.tmpDir, 'bm-sub');
  await mkdir(sub, { recursive: true });
  const deepFile = join(sub, 'bm-deep.txt');
  await writeFile(deepFile, 'find-me\n', 'utf8');

  const raw = await env.client.callTool({
    name: 'replace_text',
    arguments: {
      path: env.tmpDir,
      pattern: '*.txt', // no ** — must still recurse via baseNameMatch
      searchPattern: 'find-me',
      replacement: 'found',
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.ok((sc['totalMatches'] as number) >= 1, 'Should match find-me in the subdirectory file');
  const actual = await readFile(deepFile, 'utf8');
  assert.equal(actual, 'found\n', 'Replacement must have been applied in subdirectory file');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node scripts/tasks.mjs test --name-pattern "pattern without"
```

Expected: FAIL — `totalMatches` is 0 because `*.txt` does not recurse without `baseNameMatch`.

- [ ] **Step 3: Set `baseNameMatch: true` in `replace-in-files.ts`**

In `src/tools/replace-in-files.ts`, inside `handleSearchAndReplace`, find the `globEntries` call (around line 493). Change `baseNameMatch: false` → `true`:

```typescript
const entries = globEntries({
  cwd: root,
  pattern: filePattern, // note: filePattern comes from resolveSearchRoot after Task 5
  excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
  includeHidden: args.includeHidden,
  baseNameMatch: true, // CHANGED from false
  caseSensitiveMatch: true,
  followSymbolicLinks: false,
  onlyFiles: true,
  stats: false,
  suppressErrors: true,
  ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
});
```

> **Note:** Use `filePattern` as the variable name here (not `args.pattern ?? '**/*'`) in anticipation of Task 5 which refactors `resolveSearchRoot`. For now keep the existing expression `args.pattern ?? '**/*'` if you haven't done Task 5 yet — the important change is `baseNameMatch: true`.

- [ ] **Step 4: Add gotcha to the tool definition**

In `src/tools/replace-in-files.ts`, find the `gotchas` array inside `defineTool`. Add:

```typescript
gotchas: [
  'RE2 dialect: no lookahead, lookbehind, or backreferences.',
  'Replaces ALL occurrences per file; use `edit` for first-only replacement.',
  "Patterns without '/' match by filename anywhere in the tree (e.g. *.ts finds all .ts files). Add a path prefix like src/*.ts to restrict to a subtree.",
],
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
node scripts/tasks.mjs test --name-pattern "pattern without"
```

Expected: PASS.

- [ ] **Step 6: Run the full search test suite**

```bash
node --test --import tsx/esm "__tests__/tools/search.test.ts"
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/tools/replace-in-files.ts __tests__/tools/search.test.ts
git commit -m "fix(replace_text): set baseNameMatch=true so *.ext patterns recurse"
```

---

## Task 3 — `search_text`: `baseNameMatch: true` for recursive glob

**Files:**

- Modify: `src/tools/search-content.ts` (`SEARCH_CONTENT_DEFAULTS`)
- Modify: `__tests__/tools/search.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Add inside `describe('grep tool', ...)` in `__tests__/tools/search.test.ts`:

```typescript
it('pattern without / matches files in subdirectories (baseNameMatch)', async () => {
  // env already has sub/deep.txt with 'another apple here'
  const raw = await env.client.callTool({
    name: 'search_text',
    arguments: {
      path: env.tmpDir,
      pattern: '*.txt', // no ** — must still recurse via baseNameMatch
      searchPattern: 'another apple',
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  const matches = sc['matches'] as Record<string, unknown>[];
  assert.ok(
    Array.isArray(matches) && matches.length >= 1,
    'Should find match in sub/deep.txt with *.txt pattern',
  );
  const files = matches.map((m) => m['file'] as string);
  assert.ok(
    files.some((f) => f.includes('deep.txt')),
    `Expected sub/deep.txt in results, got: ${JSON.stringify(files)}`,
  );
});
```

> The `grep tool` `before` block already creates `sub/deep.txt` with `'another apple here\n'`.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node scripts/tasks.mjs test --name-pattern "grep tool"
```

Expected: the new test FAILs — `sub/deep.txt` is not found with `pattern: '*.txt'`.

- [ ] **Step 3: Set `baseNameMatch: true` in `SEARCH_CONTENT_DEFAULTS`**

In `src/tools/search-content.ts`, find `SEARCH_CONTENT_DEFAULTS` (around line 205):

```typescript
const SEARCH_CONTENT_DEFAULTS: ResolvedOptions = {
  filePattern: '**/*',
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  caseSensitive: false,
  maxResults: SEARCH_CONTENT_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  wholeWord: false,
  isLiteral: true,
  includeHidden: false,
  baseNameMatch: true, // CHANGED from false
  caseSensitiveFileMatch: true,
};
```

- [ ] **Step 4: Add gotcha to the `search_text` tool definition**

In `src/tools/search-content.ts`, find the `defineTool` call for `SEARCH_CONTENT` (around line 1572). Update `gotchas`:

```typescript
gotchas: [
  'RE2 dialect: no lookahead, lookbehind, or backreferences.',
  'Use `pattern` to scope to specific files; without it, scans every text file.',
  'Skips binary/oversized files silently — verify with `stat` if no matches.',
  "Patterns without '/' match by filename anywhere in the tree (e.g. *.ts finds all .ts files). Add a path prefix like src/*.ts to restrict to a subtree.",
],
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
node scripts/tasks.mjs test --name-pattern "grep tool"
```

Expected: all grep tool tests pass including the new one.

- [ ] **Step 6: Commit**

```bash
git add src/tools/search-content.ts __tests__/tools/search.test.ts
git commit -m "fix(search_text): set baseNameMatch=true so *.ext patterns recurse"
```

---

## Task 4 — `delete`: `ok: false` on total failure

**Files:**

- Modify: `src/tools/delete-file.ts` (schema + `handleDelete`)
- Modify: `__tests__/tools/directory.test.ts` (add assertions + new test)

- [ ] **Step 1: Write the failing test**

In `__tests__/tools/directory.test.ts`, find `describe('delete: processes all paths in batch', ...)`. Add a new test after the existing batch tests:

```typescript
it('returns ok:false when every path fails', async () => {
  const raw = await env.client.callTool({
    name: 'delete',
    arguments: {
      paths: [join(env.tmpDir, 'no-such-a.txt'), join(env.tmpDir, 'no-such-b.txt')],
    },
  });
  assertOk(raw); // isError should still be undefined
  const sc = getStructured(raw);
  assert.equal(sc['ok'], false, 'ok must be false when every path fails');
  const failures = sc['failures'] as Record<string, unknown>[] | undefined;
  assert.ok(Array.isArray(failures) && failures.length === 2, 'Expected 2 failures');
});

it('returns ok:true when at least one path succeeds (partial failure)', async () => {
  const goodFile = join(env.tmpDir, 'partial-good.txt');
  await writeFile(goodFile, '', 'utf8');
  const raw = await env.client.callTool({
    name: 'delete',
    arguments: {
      paths: [goodFile, join(env.tmpDir, 'no-such-c.txt')],
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.equal(sc['ok'], true, 'ok must be true when at least one path succeeds');
  const failures = sc['failures'] as Record<string, unknown>[] | undefined;
  assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
});
```

You also need `writeFile` in the import at the top of `directory.test.ts`. Check if it is already imported; if not, add it:

```typescript
import { mkdir, writeFile } from 'node:fs/promises';
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
node scripts/tasks.mjs test --name-pattern "returns ok"
```

Expected: both new tests FAIL — current schema returns `ok: true` always.

- [ ] **Step 3: Change the schema in `delete-file.ts`**

In `src/tools/delete-file.ts`, `DeleteOutputSchema`:

```typescript
// BEFORE
const DeleteOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  ...
});

// AFTER
const DeleteOutputSchema = z.strictObject({
  ok: z.boolean().describe('Success indicator — false only when every path failed'),
  ...
});
```

- [ ] **Step 4: Update `handleDelete` to compute `ok`**

In `src/tools/delete-file.ts`, `handleDelete`, find:

```typescript
const output: DeleteOutput = { ok: true as const };
```

Replace with:

```typescript
const ok = successPaths.length > 0 || args.paths.length === 0;
const output: DeleteOutput = { ok };
```

- [ ] **Step 5: Add gotcha to the tool definition**

In `src/tools/delete-file.ts`, find the `defineTool` call. Update `gotchas`:

```typescript
gotchas: [
  'Non-empty directories require `recursive=true`.',
  'ok: false only when every path failed. Partial failures return ok: true — always check failures[] for per-path errors.',
],
```

- [ ] **Step 6: Run the new tests and confirm they pass**

```bash
node scripts/tasks.mjs test --name-pattern "returns ok"
```

Expected: both new tests PASS.

- [ ] **Step 7: Run the full directory test suite**

```bash
node --test --import tsx/esm "__tests__/tools/directory.test.ts"
```

Expected: all pass. The existing delete tests that check `failures` do not assert `sc['ok'] === true`, so they are unaffected by the new `ok: false` case (those tests are single-path failures — all-fail — but they do not assert `ok`). If any existing test asserts `ok: true` explicitly on a total-failure call, update it to `ok: false`.

- [ ] **Step 8: Commit**

```bash
git add src/tools/delete-file.ts __tests__/tools/directory.test.ts
git commit -m "fix(delete): return ok:false when every path fails, ok:true on partial"
```

---

## Task 5 — `replace_text`: auto-detect file path

**Files:**

- Modify: `src/tools/replace-in-files.ts` (add `globEscape`, refactor `resolveSearchRoot`, update `handleSearchAndReplace`)
- Modify: `__tests__/tools/search.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Add inside `describe('search_and_replace tool', ...)` in `__tests__/tools/search.test.ts`:

```typescript
it('accepts a file path directly and scopes search to that file', async () => {
  const targetFile = join(env.tmpDir, 'target-only.txt');
  const siblingFile = join(env.tmpDir, 'sibling.txt');
  await writeFile(targetFile, 'needle in target\n', 'utf8');
  await writeFile(siblingFile, 'needle in sibling\n', 'utf8');

  const raw = await env.client.callTool({
    name: 'replace_text',
    arguments: {
      path: targetFile, // file path, not directory
      searchPattern: 'needle',
      replacement: 'pin',
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.equal(sc['filesModified'], 1, 'Should modify exactly 1 file');

  const targetActual = await readFile(targetFile, 'utf8');
  assert.equal(targetActual, 'pin in target\n', 'target-only.txt must be modified');

  const siblingActual = await readFile(siblingFile, 'utf8');
  assert.equal(siblingActual, 'needle in sibling\n', 'sibling.txt must NOT be modified');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
node scripts/tasks.mjs test --name-pattern "accepts a file path directly"
```

Expected: FAIL — `filesModified` is 0 because `globEntries` receives a file path as `cwd`.

- [ ] **Step 3: Add `globEscape` helper and `stat` import to `replace-in-files.ts`**

At the top of `src/tools/replace-in-files.ts`, add `stat` to the `node:fs/promises` import:

```typescript
import { open, stat } from 'node:fs/promises';
```

Then add the `globEscape` function near the top of the file (after the imports, before the schema):

```typescript
function globEscape(name: string): string {
  return name.replace(/[*?[\]{}()!|+@\\]/g, '\\$&');
}
```

- [ ] **Step 4: Refactor `resolveSearchRoot` to return `{ root, filePattern }`**

Replace the existing `resolveSearchRoot` function:

```typescript
// BEFORE
async function resolveSearchRoot(
  pathValue: string | undefined,
  pathGuard: PathGuard,
): Promise<string> {
  return pathValue
    ? pathGuard.validateExistingPath(pathValue)
    : pathGuard.resolvePathOrRoot(pathValue);
}

// AFTER
async function resolveSearchRoot(
  pathValue: string | undefined,
  pathGuard: PathGuard,
): Promise<{ root: string; filePattern: string | undefined }> {
  const resolvedPath = pathValue
    ? await pathGuard.validateExistingPath(pathValue)
    : pathGuard.resolvePathOrRoot(pathValue);

  const fileStats = await stat(resolvedPath);
  if (fileStats.isFile()) {
    return { root: dirname(resolvedPath), filePattern: globEscape(basename(resolvedPath)) };
  }
  return { root: resolvedPath, filePattern: undefined };
}
```

- [ ] **Step 5: Update `handleSearchAndReplace` to use the new return value**

In `handleSearchAndReplace`, replace:

```typescript
// BEFORE
const root = await resolveSearchRoot(args.path, pathGuard);

const entries = globEntries({
  cwd: root,
  pattern: args.pattern ?? '**/*',
  ...
```

With:

```typescript
// AFTER
const { root, filePattern } = await resolveSearchRoot(args.path, pathGuard);
const effectivePattern = filePattern ?? args.pattern ?? '**/*';

const entries = globEntries({
  cwd: root,
  pattern: effectivePattern,
  ...
```

The rest of the `globEntries` options remain unchanged (including `baseNameMatch: true` from Task 2).

- [ ] **Step 6: Add gotcha to the tool definition**

Add to the `gotchas` array in `defineTool`:

```typescript
"Passing a file path auto-scopes the search to that single file. To combine a directory scope with a glob filter, pass the directory as path and use the pattern field.",
```

- [ ] **Step 7: Run the test and confirm it passes**

```bash
node scripts/tasks.mjs test --name-pattern "accepts a file path directly"
```

Expected: PASS — `filesModified: 1`, `target-only.txt` changed, `sibling.txt` unchanged.

- [ ] **Step 8: Run the full search test suite**

```bash
node --test --import tsx/esm "__tests__/tools/search.test.ts"
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/tools/replace-in-files.ts __tests__/tools/search.test.ts
git commit -m "fix(replace_text): auto-detect file path, scope glob to that file"
```

---

## Task 6 — Full suite verification

- [ ] **Step 1: Run the full check pipeline**

```bash
node scripts/tasks.mjs check
```

Expected: format → lint → type-check → knip → test → rebuild all pass.

- [ ] **Step 2: Handle snapshot updates if needed**

If `__tests__/schemas/snapshot.test.ts` fails because the `delete` tool output schema changed (`ok: z.literal(true)` → `z.boolean()`), update snapshots:

```bash
node scripts/tasks.mjs test --update-snapshots
```

Then re-run check:

```bash
node scripts/tasks.mjs check
```

- [ ] **Step 3: Commit snapshot updates (if any)**

```bash
git add __tests__/schemas/
git commit -m "test: update schema snapshots for delete ok:boolean change"
```

---

## Self-review notes

- **Spec coverage:** All four design changes are covered (Tasks 1–5). Task 6 covers the final verification gate.
- **No placeholders:** All steps contain full code.
- **Type consistency:** `resolveSearchRoot` return type `{ root: string; filePattern: string | undefined }` is destructured as `{ root, filePattern }` in `handleSearchAndReplace` — consistent. `globEscape` is defined before its use. `stat` is imported before `resolveSearchRoot` calls it.
- **Test imports:** `mkdir` is already imported in `search.test.ts` (used in the `grep tool` `before` block). `writeFile` is already imported. Verify `writeFile` is in `directory.test.ts` imports before Task 4 Step 1.
