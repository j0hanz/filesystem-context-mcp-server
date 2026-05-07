# MCP v2 Local Agent Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `read` and `grep` tools with Tree-sitter AST awareness (symbol extraction, outline, structural queries), and add optimistic-concurrency hash guards plus proactive `notifications/resources/updated` emissions to the `write` and `edit` tools.

**Architecture:** Two independent phases — (A) AST: a lazy-loaded `src/lib/ast-parser.ts` singleton wired into existing tool handlers via optional schema fields; (B) Reactivity: a new `STALE_CONTENT` error code, an `expectedHash` guard on `write`/`edit`, and post-mutation resource notifications emitted via `ctx.sendNotification`.

**Tech Stack:** `tree-sitter` + `tree-sitter-typescript` + `tree-sitter-javascript` (native Node.js bindings, pre-built binaries), Node.js `node:path`, `node:url`, MCP SDK `ctx.sendNotification`.

---

## File Map

| Action | File                                 | Purpose                                                                                                                                                                                                                 |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create | `src/lib/ast-parser.ts`              | Lazy-loads tree-sitter parsers; exports `getOutline`, `extractSymbol`, `runAstQuery`                                                                                                                                    |
| Modify | `src/schemas.ts`                     | Add `outlineOnly`, `symbol` to `ReadFileInputSchema`; `isOutline`, `symbolName` to `ReadFileOutputSchema`; `astQuery` to `SearchContentInputSchema`; `expectedHash` to `WriteFileInputSchema` and `EditFileInputSchema` |
| Modify | `src/tools/read.ts`                  | Handle `outlineOnly` and `symbol` before normal read path                                                                                                                                                               |
| Modify | `src/tools/search-content.ts`        | Short-circuit to AST path when `astQuery` is set                                                                                                                                                                        |
| Modify | `src/tools/shared.ts`                | Export `fileToResourceUri` helper                                                                                                                                                                                       |
| Modify | `src/tools/write-file.ts`            | Add hash guard + post-write notification                                                                                                                                                                                |
| Modify | `src/tools/edit-file.ts`             | Add hash guard + post-edit notification                                                                                                                                                                                 |
| Modify | `src/config.ts`                      | Add `STALE_CONTENT` to `ErrorCode`                                                                                                                                                                                      |
| Create | `__tests__/unit/ast-parser.test.ts`  | Unit tests for AST parser                                                                                                                                                                                               |
| Create | `__tests__/tools/stale-hash.test.ts` | Integration tests for hash guards                                                                                                                                                                                       |

---

## Phase A: Tree-sitter AST Integration

---

### Task 1: Install tree-sitter dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
npm install tree-sitter tree-sitter-typescript tree-sitter-javascript
npm install --save-dev @types/tree-sitter
```

- [ ] **Step 2: Verify the import resolves in Node.js**

```bash
node --input-type=module --eval "import Parser from 'tree-sitter'; console.log(typeof Parser)"
```

Expected output: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(ast): add tree-sitter native bindings"
```

---

### Task 2: Create `src/lib/ast-parser.ts`

**Files:**

- Create: `src/lib/ast-parser.ts`
- Create: `__tests__/unit/ast-parser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/ast-parser.test.ts`:

```typescript
import assert from 'node:assert/strict';

import { describe, it } from 'node:test';

import {
  extractSymbol,
  getOutline,
  runAstQuery,
} from '../../src/lib/ast-parser.js';

const TS_SOURCE = `
import { foo } from './foo.js';

export interface Opts {
  timeout: number;
}

export async function start(opts: Opts): Promise<void> {
  await doWork(opts.timeout);
}

export class Server {
  private port: number;
  constructor(port: number) { this.port = port; }
  listen(): void { console.log(this.port); }
}
`.trim();

describe('ast-parser', () => {
  it('getOutline returns imports and signatures without bodies', async () => {
    const outline = await getOutline(TS_SOURCE, '.ts');
    assert.ok(outline !== null, 'outline should not be null for .ts');
    assert.ok(
      outline.includes("import { foo } from './foo.js'"),
      'import present'
    );
    assert.ok(
      outline.includes('async function start'),
      'function signature present'
    );
    assert.ok(outline.includes('class Server'), 'class present');
    assert.ok(!outline.includes('doWork'), 'function body not in outline');
    assert.ok(!outline.includes('console.log'), 'method body not in outline');
  });

  it('extractSymbol returns full source of a named function', async () => {
    const src = await extractSymbol(TS_SOURCE, '.ts', 'start');
    assert.ok(src !== null, 'symbol found');
    assert.ok(src!.includes('async function start'), 'function present');
    assert.ok(src!.includes('doWork'), 'body included');
  });

  it('extractSymbol returns null for an unknown symbol', async () => {
    const src = await extractSymbol(TS_SOURCE, '.ts', 'nonexistent');
    assert.equal(src, null);
  });

  it('returns null for unsupported file extension', async () => {
    const outline = await getOutline('x = 1', '.rb');
    assert.equal(outline, null);
  });

  it('runAstQuery finds function declarations by S-expression', async () => {
    const results = await runAstQuery(
      TS_SOURCE,
      '.ts',
      '(function_declaration name: (identifier) @name)'
    );
    assert.ok(results !== null, 'query supported for .ts');
    assert.ok(results!.length >= 1, 'at least one function found');
    assert.ok(
      results!.some((r) => r.text === 'start'),
      'start function captured'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx/esm __tests__/unit/ast-parser.test.ts
```

Expected: FAIL with `Cannot find module '../../src/lib/ast-parser.js'`

- [ ] **Step 3: Implement `src/lib/ast-parser.ts`**

```typescript
import Parser from 'tree-sitter';
import type { Language, SyntaxNode } from 'tree-sitter';

// Node types whose first-line signature is shown in an outline (body excluded).
const SIGNATURE_NODE_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'lexical_declaration',
  'variable_statement',
  'export_statement',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'ambient_declaration',
]);

// Node types that represent an import.
const IMPORT_TYPES = new Set(['import_statement', 'import_declaration']);

// Node types that are the "body" of a declaration (we stop before these in getSignatureLine).
const BODY_TYPES = new Set(['statement_block', 'class_body']);

interface LanguageEntry {
  load: () => Promise<Language>;
}

const LANGUAGE_MAP: Record<string, LanguageEntry> = {
  '.ts': {
    load: async () =>
      ((await import('tree-sitter-typescript')) as { typescript: Language })
        .typescript,
  },
  '.tsx': {
    load: async () =>
      ((await import('tree-sitter-typescript')) as { tsx: Language }).tsx,
  },
  '.js': {
    load: async () =>
      (
        (await import('tree-sitter-javascript')) as unknown as {
          default: Language;
        }
      ).default,
  },
  '.jsx': {
    load: async () =>
      (
        (await import('tree-sitter-javascript')) as unknown as {
          default: Language;
        }
      ).default,
  },
  '.mjs': {
    load: async () =>
      (
        (await import('tree-sitter-javascript')) as unknown as {
          default: Language;
        }
      ).default,
  },
  '.cjs': {
    load: async () =>
      (
        (await import('tree-sitter-javascript')) as unknown as {
          default: Language;
        }
      ).default,
  },
};

// Cache of already-initialized parsers keyed by normalized extension.
const parserCache = new Map<string, Parser>();

async function getParser(ext: string): Promise<Parser | null> {
  const key = ext.toLowerCase();
  const entry = LANGUAGE_MAP[key];
  if (!entry) return null;

  const cached = parserCache.get(key);
  if (cached) return cached;

  const lang = await entry.load();
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(key, parser);
  return parser;
}

/**
 * Returns the signature line(s) of a node, stopping before the opening brace / body.
 * For import statements, returns the full text (they have no body).
 */
function getSignatureLine(node: SyntaxNode, source: string): string {
  const firstBody = node.children.find((c) => BODY_TYPES.has(c.type));
  if (!firstBody) {
    // No body (e.g. interface, type alias, import): return full text, first line only.
    return source.slice(node.startIndex, node.endIndex).split('\n')[0] ?? '';
  }
  return source.slice(node.startIndex, firstBody.startIndex).trimEnd();
}

/**
 * Recursively searches children for a top-level declaration whose identifier
 * field text matches `symbolName`.
 */
function findSymbolNode(
  root: SyntaxNode,
  symbolName: string
): SyntaxNode | null {
  for (const child of root.children) {
    // Direct declaration with a `name` field (function_declaration, class_declaration…)
    const nameNode = child.childForFieldName?.('name');
    if (nameNode?.text === symbolName) return child;

    // export_statement wrapping a declaration
    if (child.type === 'export_statement') {
      const decl = child.childForFieldName?.('declaration');
      if (decl) {
        const declName = decl.childForFieldName?.('name');
        if (declName?.text === symbolName) return child;
      }
    }
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns an AST-extracted skeleton of the file: imports + top-level signatures
 * without implementation bodies. Returns `null` if the extension is unsupported.
 */
export async function getOutline(
  source: string,
  ext: string
): Promise<string | null> {
  const parser = await getParser(ext);
  if (!parser) return null;

  const tree = parser.parse(source);
  const lines: string[] = [];

  for (const child of tree.rootNode.children) {
    if (IMPORT_TYPES.has(child.type)) {
      lines.push(source.slice(child.startIndex, child.endIndex));
    } else if (SIGNATURE_NODE_TYPES.has(child.type)) {
      lines.push(getSignatureLine(child, source));
    }
  }

  return lines.join('\n');
}

/**
 * Extracts the full source text of a named top-level symbol (function, class,
 * variable, etc.). Returns `null` if not found or extension is unsupported.
 */
export async function extractSymbol(
  source: string,
  ext: string,
  symbolName: string
): Promise<string | null> {
  const parser = await getParser(ext);
  if (!parser) return null;

  const tree = parser.parse(source);
  const node = findSymbolNode(tree.rootNode, symbolName);
  if (!node) return null;

  return source.slice(node.startIndex, node.endIndex);
}

/**
 * Runs a tree-sitter S-expression query and returns each captured node's text
 * and source position (1-based lines). Returns `null` if extension is unsupported.
 */
export async function runAstQuery(
  source: string,
  ext: string,
  queryText: string
): Promise<Array<{ text: string; startLine: number; endLine: number }> | null> {
  const parser = await getParser(ext);
  if (!parser) return null;

  const tree = parser.parse(source);
  const lang = parser.getLanguage();
  const query = lang.query(queryText);
  const matches = query.matches(tree.rootNode);

  return matches.flatMap((m) =>
    m.captures.map((c) => ({
      text: source.slice(c.node.startIndex, c.node.endIndex),
      startLine: c.node.startPosition.row + 1,
      endLine: c.node.endPosition.row + 1,
    }))
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test --import tsx/esm __tests__/unit/ast-parser.test.ts
```

Expected: 5 passing, 0 failing

- [ ] **Step 5: Commit**

```bash
git add src/lib/ast-parser.ts __tests__/unit/ast-parser.test.ts
git commit -m "feat(ast): add ast-parser singleton (outline/symbol/query)"
```

---

### Task 3: Augment `ReadFileInputSchema` and `ReadFileOutputSchema` in `src/schemas.ts`

**Files:**

- Modify: `src/schemas.ts`

- [ ] **Step 1: Write the failing test**

Add to `__tests__/tools/read-write.test.ts` inside the existing `describe('read tool', ...)` block, before the closing `}`):

```typescript
it('returns an outline when outlineOnly is true', async () => {
  const tsFile = join(env.tmpDir, 'outline.ts');
  await writeFile(
    tsFile,
    [
      "import { x } from './x.js';",
      'export function greet(name: string): string {',
      '  return `hello ${name}`;',
      '}',
    ].join('\n'),
    'utf8'
  );

  const raw = await env.client.callTool({
    name: 'read',
    arguments: { path: tsFile, outlineOnly: true },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.ok(
    (sc['content'] as string).includes('function greet'),
    'signature in outline'
  );
  assert.ok(
    !(sc['content'] as string).includes('hello'),
    'body not in outline'
  );
  assert.equal(sc['isOutline'], true);
});

it('extracts a named symbol when symbol is provided', async () => {
  const tsFile = join(env.tmpDir, 'symbol.ts');
  await writeFile(
    tsFile,
    [
      'export function alpha(): void {}',
      'export function beta(): void { alpha(); }',
    ].join('\n'),
    'utf8'
  );

  const raw = await env.client.callTool({
    name: 'read',
    arguments: { path: tsFile, symbol: 'beta' },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.ok((sc['content'] as string).includes('beta'), 'symbol found');
  assert.ok(
    !(sc['content'] as string).includes('alpha() {}'),
    'other symbol body excluded'
  );
  assert.equal(sc['symbolName'], 'beta');
});

it('returns NOT_FOUND when symbol does not exist', async () => {
  const tsFile = join(env.tmpDir, 'symbol2.ts');
  await writeFile(tsFile, 'export function real(): void {}', 'utf8');

  const raw = await env.client.callTool({
    name: 'read',
    arguments: { path: tsFile, symbol: 'ghost' },
  });
  assertToolError(raw, 'NOT_FOUND');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx/esm __tests__/tools/read-write.test.ts --test-name-pattern="outline|symbol"
```

Expected: FAIL (Zod strictObject rejects unknown fields `outlineOnly` and `symbol`)

- [ ] **Step 3: Add `outlineOnly` and `symbol` to `ReadFileInputSchema`**

In `src/schemas.ts`, locate `ReadFileInputSchema` (the `.strictObject({...})` block around line 353). Add two fields after the `includeHash` line, before the closing `}`:

```typescript
    outlineOnly: defaultFalseBoolean(
      'Return AST-extracted outline: imports + signatures without bodies. Unsupported extensions fall back to full read.'
    ),
    symbol: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Extract full source of a named top-level symbol (function, class, const). Returns NOT_FOUND if absent. Overrides outlineOnly.'
      ),
```

- [ ] **Step 4: Add `isOutline` and `symbolName` to `ReadFileOutputSchema`**

In `src/schemas.ts`, locate `ReadFileOutputSchema` (around line 523, the `.extend({...})` block). Add after `contentHash`:

```typescript
    isOutline: z
      .boolean()
      .optional()
      .describe('True when content is an AST-generated outline'),
    symbolName: z
      .string()
      .optional()
      .describe('Symbol name extracted when the `symbol` param was used'),
```

- [ ] **Step 5: Type-check only (do not run full tests yet)**

```bash
npm run type-check
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts
git commit -m "feat(ast): add outlineOnly/symbol to ReadFileInputSchema, isOutline/symbolName to output"
```

---

### Task 4: Implement `outlineOnly` and `symbol` in `src/tools/read.ts`

**Files:**

- Modify: `src/tools/read.ts`

- [ ] **Step 1: Add imports**

In `src/tools/read.ts`, change the `node:path` import line from:

```typescript
import { basename } from 'node:path';
```

to:

```typescript
import { basename, extname } from 'node:path';
```

Add after the `import { calculateFileContentHash, readFile } from '../lib/fs-helpers.js';` line:

```typescript
import { extractSymbol, getOutline } from '../lib/ast-parser.js';
```

Add `McpError` to the existing errors import (check current import in read.ts — if `ErrorCode` is imported from elsewhere, add `McpError` from `'../lib/errors.js'`):

```typescript
import { ErrorCode, McpError } from '../lib/errors.js';
```

- [ ] **Step 2: Add AST dispatch inside `handleReadFile`**

In `handleReadFile`, after the line `const result = await readFile(args.path, options);` and before `const structured = toStructuredReadFileResult(args, result);`, insert:

```typescript
// Symbol extraction takes priority over outlineOnly.
if (args.symbol !== undefined) {
  const ext = extname(args.path);
  const symbolSrc = await extractSymbol(result.content, ext, args.symbol);
  if (symbolSrc === null) {
    throw new McpError(
      ErrorCode.NOT_FOUND,
      `Symbol '${args.symbol}' not found in ${basename(args.path)}`,
      args.path
    );
  }
  const symbolStructured: ReadFileOutput = {
    ok: true,
    path: args.path,
    content: symbolSrc,
    symbolName: args.symbol,
  };
  return buildToolResponse(symbolSrc, symbolStructured);
}

if (args.outlineOnly) {
  const ext = extname(args.path);
  const outline = await getOutline(result.content, ext);
  if (outline !== null) {
    const outlineStructured: ReadFileOutput = {
      ok: true,
      path: args.path,
      content: outline,
      isOutline: true,
    };
    return buildToolResponse(outline, outlineStructured);
  }
  // Unsupported extension: fall through to normal read path.
}
```

- [ ] **Step 3: Run the read-write tests**

```bash
node --test --import tsx/esm __tests__/tools/read-write.test.ts
```

Expected: PASS (all existing tests + 3 new outline/symbol tests)

- [ ] **Step 4: Commit**

```bash
git add src/tools/read.ts
git commit -m "feat(ast): implement outlineOnly and symbol extraction in read tool"
```

---

### Task 5: Add `astQuery` to `SearchContentInputSchema` and implement in `src/tools/search-content.ts`

**Files:**

- Modify: `src/schemas.ts`
- Modify: `src/tools/search-content.ts`
- Modify: `__tests__/tools/search.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `__tests__/tools/search.test.ts` (after the last existing `describe` block, before EOF):

```typescript
describe('grep tool – astQuery', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(
      join(env.tmpDir, 'funcs.ts'),
      [
        'export function hello(): void {}',
        'export function world(x: number): number { return x * 2; }',
        'const arrow = () => {};',
      ].join('\n'),
      'utf8'
    );
  });

  after(async () => {
    await env.cleanup();
  });

  it('finds function declarations via astQuery', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: {
        path: env.tmpDir,
        pattern: '',
        astQuery: '(function_declaration name: (identifier) @name)',
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const matches = sc['matches'] as Array<{ content: string }>;
    assert.ok(
      matches.length >= 2,
      `Expected >=2 matches, got ${matches.length}`
    );
    assert.ok(
      matches.some((m) => m.content === 'hello'),
      '"hello" captured'
    );
    assert.ok(
      matches.some((m) => m.content === 'world'),
      '"world" captured'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx/esm __tests__/tools/search.test.ts --test-name-pattern="astQuery"
```

Expected: FAIL (Zod strictObject rejects unknown field `astQuery`)

- [ ] **Step 3: Add `astQuery` to `SearchContentInputSchema` in `src/schemas.ts`**

In `src/schemas.ts`, locate `SearchContentInputSchema` (around line 314). Inside the `.strictObject({...})` block, add after the `includeIgnored` field:

```typescript
  astQuery: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      'Tree-sitter S-expression query (e.g. "(function_declaration name: (identifier) @name)"). When set, `pattern` is ignored and structural AST matching is used. Supported extensions: .ts .tsx .js .jsx .mjs .cjs.'
    ),
```

- [ ] **Step 4: Implement `astQuery` path in `src/tools/search-content.ts`**

Add the following import at the top of `src/tools/search-content.ts` alongside the existing imports:

```typescript
import { readFile as fsReadFile } from 'node:fs/promises';
import { extname, relative } from 'node:path';

import { runAstQuery } from '../lib/ast-parser.js';
```

Add this helper just before the `handleSearchContent` function:

```typescript
async function handleAstSearch(
  args: SearchInput,
  rootPath: string,
  signal?: AbortSignal
): Promise<ToolResponse<SearchOutput>> {
  // Lazily import traversal to avoid circular dep at module load time.
  const { globEntries } = await import('../lib/file-operations/traversal.js');

  const supportedExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const filePattern = args.filePattern ?? '**/*';
  const astMatches: NonNullable<SearchOutput['matches']> = [];

  for await (const entry of globEntries(rootPath, filePattern, { signal })) {
    const ext = extname(entry.path).toLowerCase();
    if (!supportedExts.has(ext)) continue;

    let source: string;
    try {
      source = await fsReadFile(entry.path, 'utf-8');
    } catch {
      continue;
    }

    const results = await runAstQuery(source, ext, args.astQuery!);
    if (!results) continue;

    for (const r of results) {
      astMatches.push({
        file: relative(rootPath, entry.path),
        line: r.startLine,
        content: r.text.split('\n')[0] ?? r.text,
        matchCount: 1,
      });
    }
  }

  const structured: SearchOutput = {
    ok: true,
    matches: astMatches,
    totalMatches: astMatches.length,
  };
  const summary =
    astMatches.length > 0
      ? `Found ${astMatches.length} AST match(es).`
      : 'No AST matches found.';
  return buildToolResponse(summary, structured);
}
```

In the main `handleSearchContent` function, add this early-exit block at the very top of the function body (before any regex/pattern handling):

```typescript
if (args.astQuery !== undefined) {
  return await handleAstSearch(args, rootPath, signal);
}
```

- [ ] **Step 5: Run search tests**

```bash
node --test --import tsx/esm __tests__/tools/search.test.ts
```

Expected: PASS (all existing + new astQuery test)

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/tools/search-content.ts __tests__/tools/search.test.ts
git commit -m "feat(ast): add astQuery param to grep tool"
```

---

## Phase B: Optimistic Concurrency & Resource Notifications

---

### Task 6: Add `STALE_CONTENT` to `ErrorCode` in `src/config.ts`

**Files:**

- Modify: `src/config.ts`

- [ ] **Step 1: Add the new error code**

In `src/config.ts`, locate the `ErrorCode` const object (around line 107). Add after the `INVALID_INPUT` line:

```typescript
  STALE_CONTENT: 'STALE_CONTENT',
```

The block should now look like:

```typescript
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
  STALE_CONTENT: 'STALE_CONTENT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SYMLINK_NOT_ALLOWED: 'SYMLINK_NOT_ALLOWED',
  UNKNOWN: 'UNKNOWN',
} as const;
```

- [ ] **Step 2: Type-check**

```bash
npm run type-check
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat(reactivity): add STALE_CONTENT to ErrorCode"
```

---

### Task 7: Add `expectedHash` to write and edit schemas, implement hash guard in `write-file.ts`

**Files:**

- Modify: `src/schemas.ts`
- Modify: `src/tools/write-file.ts`
- Create: `__tests__/tools/stale-hash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/tools/stale-hash.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  type TestEnv,
} from '../helpers.js';

// ─── write tool ──────────────────────────────────────────────────────────────

describe('write tool – expectedHash', () => {
  let env: TestEnv;
  let file: string;
  const originalContent = 'original content\n';

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'stale-write.txt');
    await writeFile(file, originalContent, 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('writes when expectedHash matches current file hash', async () => {
    const hash = createHash('sha256')
      .update(originalContent, 'utf8')
      .digest('hex');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'new content\n', expectedHash: hash },
    });
    assertOk(raw);
    const onDisk = await readFile(file, 'utf8');
    assert.equal(onDisk, 'new content\n');
  });

  it('rejects with STALE_CONTENT when expectedHash does not match', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      arguments: {
        path: file,
        content: 'should not be written\n',
        expectedHash: 'a'.repeat(64),
      },
    });
    assertToolError(raw, 'STALE_CONTENT');
  });

  it('writes normally when expectedHash is omitted', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'no hash check\n' },
    });
    assertOk(raw);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx/esm __tests__/tools/stale-hash.test.ts --test-name-pattern="write tool"
```

Expected: FAIL (Zod strictObject rejects unknown field `expectedHash`)

- [ ] **Step 3: Add `expectedHash` to `WriteFileInputSchema` in `src/schemas.ts`**

In `src/schemas.ts`, locate `WriteFileInputSchema` (around line 610). Add inside the `.strictObject({...})` block, after the `content` field:

```typescript
  expectedHash: Sha256HexSchema.optional().describe(
    'If provided, the write is rejected with STALE_CONTENT when the current file SHA-256 does not match. Get the hash via `read` with `includeHash: true`.'
  ),
```

`Sha256HexSchema` is already defined in `src/schemas.ts` — confirm by searching for it in the file (it is used in `ReadFileOutputSchema.contentHash`). Use it directly.

- [ ] **Step 4: Implement the hash guard in `src/tools/write-file.ts`**

First, ensure these are imported at the top of `src/tools/write-file.ts` (add if missing):

```typescript
import { ErrorCode, McpError } from '../lib/errors.js';
import { calculateFileContentHash } from '../lib/fs-helpers.js';
```

In `handleWriteFile`, immediately after `const validPath = await validatePathForWrite(args.path, signal);`, insert:

```typescript
if (args.expectedHash !== undefined) {
  let currentHash: string;
  try {
    currentHash = await calculateFileContentHash(validPath, signal);
  } catch {
    // File does not exist yet — treat as no hash to compare against.
    currentHash = '';
  }
  if (currentHash !== '' && currentHash !== args.expectedHash) {
    throw new McpError(
      ErrorCode.STALE_CONTENT,
      'File has been modified since last read. Re-read the file and retry.',
      args.path
    );
  }
}
```

- [ ] **Step 5: Run stale-hash tests for write**

```bash
node --test --import tsx/esm __tests__/tools/stale-hash.test.ts --test-name-pattern="write tool"
```

Expected: 3 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/tools/write-file.ts __tests__/tools/stale-hash.test.ts
git commit -m "feat(reactivity): expectedHash guard on write tool"
```

---

### Task 8: Add `expectedHash` to `EditFileInputSchema` and implement hash guard in `edit-file.ts`

**Files:**

- Modify: `src/schemas.ts`
- Modify: `src/tools/edit-file.ts`
- Modify: `__tests__/tools/stale-hash.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/tools/stale-hash.test.ts`:

```typescript
// ─── edit tool ───────────────────────────────────────────────────────────────

describe('edit tool – expectedHash', () => {
  let env: TestEnv;
  let file: string;
  const originalContent = 'hello world\n';

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'stale-edit.ts');
    await writeFile(file, originalContent, 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies edit when expectedHash matches', async () => {
    const hash = createHash('sha256')
      .update(originalContent, 'utf8')
      .digest('hex');
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'hello', newText: 'goodbye' }],
        expectedHash: hash,
      },
    });
    assertOk(raw);
    const onDisk = await readFile(file, 'utf8');
    assert.ok(onDisk.includes('goodbye'));
  });

  it('rejects with STALE_CONTENT when hash does not match', async () => {
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'goodbye', newText: 'hello' }],
        expectedHash: 'dead' + 'b'.repeat(60),
      },
    });
    assertToolError(raw, 'STALE_CONTENT');
  });

  it('edits normally when expectedHash is omitted', async () => {
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'goodbye', newText: 'hello' }],
      },
    });
    assertOk(raw);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test --import tsx/esm __tests__/tools/stale-hash.test.ts --test-name-pattern="edit tool"
```

Expected: FAIL (Zod rejects unknown field `expectedHash` on edit schema)

- [ ] **Step 3: Add `expectedHash` to `EditFileInputSchema` in `src/schemas.ts`**

In `src/schemas.ts`, locate `EditFileInputSchema` (around line 621). Add inside the `.strictObject({...})` block, after the `ignoreWhitespace` field:

```typescript
  expectedHash: Sha256HexSchema.optional().describe(
    'If provided, the edit is rejected with STALE_CONTENT when the current file SHA-256 does not match. Get the hash via `read` with `includeHash: true`.'
  ),
```

- [ ] **Step 4: Implement the hash guard in `src/tools/edit-file.ts`**

First, ensure `calculateFileContentHash` is imported (add to existing imports in edit-file.ts):

```typescript
import { calculateFileContentHash } from '../lib/fs-helpers.js';
```

`McpError` and `ErrorCode` are already imported in `edit-file.ts`. If not, add:

```typescript
import { ErrorCode, McpError } from '../lib/errors.js';
```

In `handleEditFile`, immediately after `const { validPath, content } = await loadEditableFile(args.path, signal);`, insert:

```typescript
if (args.expectedHash !== undefined) {
  const currentHash = await calculateFileContentHash(validPath, signal);
  if (currentHash !== args.expectedHash) {
    throw new McpError(
      ErrorCode.STALE_CONTENT,
      'File has been modified since last read. Re-read the file and retry.',
      args.path
    );
  }
}
```

- [ ] **Step 5: Run all stale-hash tests**

```bash
node --test --import tsx/esm __tests__/tools/stale-hash.test.ts
```

Expected: 6 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/tools/edit-file.ts __tests__/tools/stale-hash.test.ts
git commit -m "feat(reactivity): expectedHash guard on edit tool"
```

---

### Task 9: Emit `notifications/resources/updated` from write and edit tools

**Files:**

- Modify: `src/tools/shared.ts`
- Modify: `src/tools/write-file.ts`
- Modify: `src/tools/edit-file.ts`
- Modify: `__tests__/tools/stale-hash.test.ts`

After a successful mutation, the server notifies any subscribed MCP client via `notifications/resources/updated`. We use `ctx.sendNotification` (already in `ToolContext`) to send this notification directly from within the tool's `run` callback — no server instance reference needed.

- [ ] **Step 1: Add `fileToResourceUri` to `src/tools/shared.ts`**

Add the following import near the top of `src/tools/shared.ts` (alongside other `node:*` imports):

```typescript
import { pathToFileURL } from 'node:url';
```

Add the following exported function near the other small utility exports:

```typescript
/**
 * Converts an absolute filesystem path to a `file://` URI string suitable
 * for MCP `notifications/resources/updated` params.
 */
export function fileToResourceUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}
```

- [ ] **Step 2: Write the failing test**

Append to `__tests__/tools/stale-hash.test.ts`:

```typescript
import { pathToFileURL } from 'node:url';

// ─── resource notifications ──────────────────────────────────────────────────

describe('write tool – resource notifications', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('emits notifications/resources/updated after successful write', async () => {
    const file = join(env.tmpDir, 'notif.txt');
    const fileUri = pathToFileURL(file).href;

    const notifiedUris: string[] = [];
    env.client.setNotificationHandler(
      { method: 'notifications/resources/updated' } as { method: string },
      (n: { params?: { uri?: string } }) => {
        if (n.params?.uri) notifiedUris.push(n.params.uri);
      }
    );

    await env.client.callTool({
      name: 'write',
      arguments: { path: file, content: 'v1\n' },
    });

    // Allow the async notification a tick to arrive.
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.ok(
      notifiedUris.includes(fileUri),
      `Expected ${fileUri} in ${JSON.stringify(notifiedUris)}`
    );
  });
});
```

> **Note:** If `client.setNotificationHandler` is not available on the test `Client` instance, consult the `@modelcontextprotocol/client` API and adapt this test to use the available notification hook. The server-side behavior (`ctx.sendNotification` is called) is what matters.

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test --import tsx/esm __tests__/tools/stale-hash.test.ts --test-name-pattern="resource notifications"
```

Expected: FAIL (no notification received)

- [ ] **Step 4: Emit notification in `src/tools/write-file.ts`**

Add the import for `fileToResourceUri` in `write-file.ts`:

```typescript
import { ..., fileToResourceUri } from './shared.js';
```

In `registerWriteFileTool`'s `executeToolWithDiagnostics` `run` callback, after `const result = await handleWriteFile(args, signal);` and the existing `void ctx.log?.(...)` call, add:

```typescript
if (ctx.sendNotification) {
  void ctx.sendNotification({
    method: 'notifications/resources/updated',
    params: { uri: fileToResourceUri(args.path) },
  });
}
```

- [ ] **Step 5: Emit notification in `src/tools/edit-file.ts`**

Add the import for `fileToResourceUri` in `edit-file.ts`:

```typescript
import { ..., fileToResourceUri } from './shared.js';
```

In `registerEditFileTool`'s `executeToolWithDiagnostics` `run` callback, after `const result = await handleEditFile(args, signal);`, add:

```typescript
if (ctx.sendNotification && !args.dryRun) {
  void ctx.sendNotification({
    method: 'notifications/resources/updated',
    params: { uri: fileToResourceUri(args.path) },
  });
}
```

Note: `dryRun` edits don't write to disk, so they must not emit a resource update.

- [ ] **Step 6: Run the notification test**

```bash
node --test --import tsx/esm __tests__/tools/stale-hash.test.ts --test-name-pattern="resource notifications"
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/tools/shared.ts src/tools/write-file.ts src/tools/edit-file.ts __tests__/tools/stale-hash.test.ts
git commit -m "feat(reactivity): emit notifications/resources/updated from write and edit"
```

---

### Task 10: Full validation

**Files:** none

- [ ] **Step 1: Run the full task pipeline**

```bash
node scripts/tasks.mjs
```

Expected: All stages pass — format → lint + type-check + knip → test + rebuild — with 0 errors and 0 warnings.

- [ ] **Step 2: Check contract test for tool count**

Open `__tests__/contract.test.ts` and verify the test still expects 18 registered tools (no tools were added or removed — only schemas changed). If the count assertion is there and still at 18, no change is needed.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: mcp-v2 local agent optimizations complete (ast + reactivity)"
```

---

## Self-Review Checklist

- **Spec coverage:** ✅ `outlineOnly` / `symbol` in `read`, `astQuery` in `grep`, hash guards on `write` + `edit`, resource notifications from `write` + `edit`.
- **No placeholders:** All steps contain actual code.
- **Type consistency:** `ReadFileOutput` uses `isOutline` / `symbolName` in both schema and handler. `ErrorCode.STALE_CONTENT` added once in `config.ts`, used in both `write-file.ts` and `edit-file.ts`. `fileToResourceUri` exported from `shared.ts`, imported in both mutation tools.
- **YAGNI:** No new tools added; only existing schemas extended. WatchManager for external file changes (out-of-band mutations) is explicitly deferred — not part of this plan.
