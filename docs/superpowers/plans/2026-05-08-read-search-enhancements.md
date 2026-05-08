# Read & Search Precision Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add byte-range reads to the `read` tool and asymmetric context lines + fuzzy matching to the `grep` tool, without breaking any existing functionality.

**Architecture:** Schema changes feed down through the existing `ReadFileOptions`/`SearchContentOptions` layer into the `fs-helpers`/`search` engine layer; the tool layer wires new params through existing `buildReadOptions`/`executeSearch` helpers. All new params are strictly optional — existing call-sites need zero changes.

**Tech Stack:** TypeScript (NodeNext), Zod v4, `node:fs/promises` (`FileHandle.createReadStream`), `node:readline`, existing `RE2` matcher.

---

## File Map

| File                                 | Change                                                                                                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schemas/shared.ts`              | Extend `validateReadRange` to reject `offset`/`length` mixed with line params                                                                                                                           |
| `src/schemas/inputs.ts`              | Add `offset`, `length` to `ReadFileInputSchema`; add `contextBefore`, `contextAfter`, `fuzzy` to `GrepInputSchema`                                                                                      |
| `src/schemas/json-schema.ts`         | Add byte-range mutual-exclusion entries to `readRangeConstraints`                                                                                                                                       |
| `src/schemas/outputs.ts`             | Add `reachedEOF`, `bytesRead`, `offset` to `ReadFileOutputSchema`                                                                                                                                       |
| `src/lib/fs-helpers.ts`              | Add `byteRange` `ReadMode`; add `offset`/`length` to option + result types; implement `executeByteRangeRead`                                                                                            |
| `src/tools/read.ts`                  | Wire `offset`/`length` through `buildReadOptions`, `toStructuredReadFileResult`, progress/completion messages                                                                                           |
| `src/lib/file-operations/search.ts`  | Add `contextBefore`/`contextAfter` to schema + defaults; refactor `ContextBuffer` constructor; update `ScanFileOptions`, `buildScanOptions`, `readMatches`; add fuzzy matcher + `MAX_FUZZY_FILES` guard |
| `src/tools/search-content.ts`        | Wire `contextBefore`/`contextAfter`/`fuzzy` through `executeSearch`                                                                                                                                     |
| `__tests__/tools/read-write.test.ts` | New byte-range test cases                                                                                                                                                                               |
| `__tests__/tools/search.test.ts`     | New asymmetric-context + fuzzy test cases                                                                                                                                                               |

---

## Task 1: Byte-range reads — Schema layer

**Files:**

- Modify: `src/schemas/shared.ts`
- Modify: `src/schemas/inputs.ts`
- Modify: `src/schemas/json-schema.ts`
- Modify: `src/schemas/outputs.ts`

- [ ] **Step 1: Extend `validateReadRange` in `src/schemas/shared.ts`**

Add a check that rejects mixing `offset`/`length` with any line-based param. Find the existing `validateReadRange` function and add at the end, before the closing brace:

```typescript
// existing signature stays the same, just extend the value type:
export function validateReadRange(
  value: {
    head?: number | undefined;
    tail?: number | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
    offset?: number | undefined;
    length?: number | undefined;
  },
  ctx: z.RefinementCtx
): void {
  // ... keep all existing checks unchanged ...

  // NEW: byte range is mutually exclusive with all line-based params
  const hasByteRange = value.offset !== undefined || value.length !== undefined;
  if (hasByteRange && (hasHead || hasTail || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['offset'],
      message:
        "Cannot use 'offset'/'length' with line-based params (head/tail/startLine/endLine)",
      input: value,
    });
  }
}
```

The full replacement for `validateReadRange` (preserving existing checks):

```typescript
export function validateReadRange(
  value: {
    head?: number | undefined;
    tail?: number | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
    offset?: number | undefined;
    length?: number | undefined;
  },
  ctx: z.RefinementCtx
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;
  const hasByteRange = value.offset !== undefined || value.length !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head'],
      message: "Cannot use 'head' with 'startLine'/'endLine'",
      input: value,
    });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tail'],
      message: "Cannot use 'tail' with 'head'/'startLine'/'endLine'",
      input: value,
    });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' must be >= 'startLine'",
      input: value,
    });
  }
  if (hasByteRange && (hasHead || hasTail || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['offset'],
      message:
        "Cannot use 'offset'/'length' with line-based params (head/tail/startLine/endLine)",
      input: value,
    });
  }
}
```

- [ ] **Step 2: Add `offset` and `length` to `ReadFileInputSchema` in `src/schemas/inputs.ts`**

Find the `readRangeFields` const and the `ReadFileInputSchema` block. Add two new optional fields:

```typescript
const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

export const ReadFileInputSchema = z
  .strictObject({
    path: RequiredPath,
    includeHash: defaultFalseBoolean('Include SHA-256 hash of the content'),
    ...readRangeFields,
    offset: z
      .uint32()
      .optional()
      .describe(
        'Byte offset to start reading (mutually exclusive with line params)'
      ),
    length: z
      .uint32()
      .min(1)
      .optional()
      .describe(
        'Number of bytes to read (used with offset; reads to EOF if omitted)'
      ),
  })
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
        offset: value.offset,
        length: value.length,
      },
      ctx
    );
  });
```

- [ ] **Step 3: Add byte-range constraints to `readRangeConstraints` in `src/schemas/json-schema.ts`**

Find `readRangeConstraints()` and add two `not` entries:

```typescript
export function readRangeConstraints(): JsonSchema[] {
  return [
    // head and tail are mutually exclusive
    { not: { required: ['head', 'tail'] } },
    // tail cannot be combined with startLine or endLine
    { not: { required: ['tail', 'startLine'] } },
    { not: { required: ['tail', 'endLine'] } },
    // head cannot be combined with startLine or endLine
    { not: { required: ['head', 'startLine'] } },
    { not: { required: ['head', 'endLine'] } },
    // byte range is mutually exclusive with all line params
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
```

- [ ] **Step 4: Add `reachedEOF`, `bytesRead`, `offset` to `ReadFileOutputSchema` in `src/schemas/outputs.ts`**

Find the `ReadFileOutputSchema` and add three new optional fields at the end:

```typescript
export const ReadFileOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  path: z.string().describe('Resolved path'),
  content: z.string().optional().describe('File content'),
  resourceUri: z
    .string()
    .optional()
    .describe('Full content URI when externalized'),
  continuation: ContinuationSchema.optional().describe(
    'Present when file was cut; call the named tool with the given args to read next chunk'
  ),
  totalLines: NonNegInt.optional().describe('Total lines in file'),
  linesRead: NonNegInt.optional().describe('Lines returned'),
  hasMoreLines: z.boolean().optional().describe('More lines available'),
  head: PositiveInt.optional().describe('Head lines requested'),
  tail: PositiveInt.optional().describe('Tail lines requested'),
  startLine: PositiveInt.optional().describe('Start line'),
  endLine: PositiveInt.optional().describe('End line'),
  contentHash: Sha256Hex.optional().describe(
    'SHA-256 of content (when includeHash)'
  ),
  // Byte-range fields
  offset: NonNegInt.optional().describe('Byte offset used'),
  bytesRead: NonNegInt.optional().describe('Bytes returned'),
  reachedEOF: z.boolean().optional().describe('Read reached end of file'),
});
```

- [ ] **Step 5: Run type-check to verify schema layer compiles**

```bash
node scripts/tasks.mjs --quick
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/shared.ts src/schemas/inputs.ts src/schemas/json-schema.ts src/schemas/outputs.ts
git commit -m "feat(schemas): add byte-range params to read tool schema"
```

---

## Task 2: Byte-range reads — `fs-helpers` implementation

**Files:**

- Modify: `src/lib/fs-helpers.ts`

- [ ] **Step 1: Add `offset` and `length` to `ReadFileOptions` and `NormalizedOptions` interfaces**

Find the two interfaces and add two optional fields to each:

```typescript
interface ReadFileOptions {
  encoding?: BufferEncoding;
  maxSize?: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  skipBinary?: boolean;
  signal?: AbortSignal;
  offset?: number; // NEW
  length?: number; // NEW
}

interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  skipBinary: boolean;
  signal?: AbortSignal;
  offset?: number; // NEW
  length?: number; // NEW
}
```

- [ ] **Step 2: Add `'byteRange'` to `ReadMode` type**

Find `type ReadMode = 'head' | 'full' | 'range' | 'tail';` and change to:

```typescript
type ReadMode = 'head' | 'full' | 'range' | 'tail' | 'byteRange';
```

- [ ] **Step 3: Add `reachedEOF`, `bytesRead`, `offset` to `ReadFileResult` interface**

Find `interface ReadFileResult` and add three new optional fields:

```typescript
interface ReadFileResult {
  path: string;
  content: string;
  truncated: boolean;
  totalLines?: number;
  readMode: ReadMode;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  linesRead?: number;
  hasMoreLines?: boolean;
  // Byte-range fields
  offset?: number;
  bytesRead?: number;
  reachedEOF?: boolean;
}
```

- [ ] **Step 4: Extend `validateReadOptions` to validate `offset`/`length`**

Find `validateReadOptions` and add validation for the new fields:

```typescript
function validateReadOptions(options: ReadFileOptions): void {
  const hasHead = options.head !== undefined;
  const hasTail = options.tail !== undefined;
  const hasStart = options.startLine !== undefined;
  const hasEnd = options.endLine !== undefined;

  assertPositiveSafeIntegerOption(
    'maxSize',
    options.maxSize,
    'maxSize must be at least 1'
  );
  assertPositiveSafeIntegerOption(
    'head',
    options.head,
    'head must be at least 1'
  );
  // ... keep all other existing assertions ...

  // NEW: validate offset/length
  if (options.offset !== undefined && options.offset < 0) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'offset must be >= 0');
  }
  if (options.length !== undefined && options.length < 1) {
    throw new McpError(ErrorCode.INVALID_INPUT, 'length must be >= 1');
  }
  const hasByteRange =
    options.offset !== undefined || options.length !== undefined;
  if (hasByteRange && (hasHead || hasTail || hasStart || hasEnd)) {
    throw new McpError(
      ErrorCode.INVALID_INPUT,
      "Cannot use 'offset'/'length' with line-based params"
    );
  }
}
```

- [ ] **Step 5: Extend `normalizeOptions` to propagate `offset`/`length`**

Find `normalizeOptions` and add the new fields just like the existing optional fields:

```typescript
function normalizeOptions(options: ReadFileOptions): NormalizedOptions {
  validateReadOptions(options);

  const normalized: NormalizedOptions = {
    encoding: options.encoding ?? 'utf-8',
    maxSize: Math.min(
      options.maxSize ?? MAX_TEXT_FILE_SIZE,
      MAX_TEXT_FILE_SIZE
    ),
    skipBinary: options.skipBinary ?? false,
  };

  if (options.head !== undefined) {
    normalized.head = options.head;
  }
  if (options.tail !== undefined) {
    normalized.tail = options.tail;
  }
  if (options.startLine !== undefined) {
    normalized.startLine = options.startLine;
  }
  if (options.endLine !== undefined) {
    normalized.endLine = options.endLine;
  }
  if (options.signal !== undefined) {
    normalized.signal = options.signal;
  }
  // NEW
  if (options.offset !== undefined) {
    normalized.offset = options.offset;
  }
  if (options.length !== undefined) {
    normalized.length = options.length;
  }

  return normalized;
}
```

- [ ] **Step 6: Extend `resolveReadMode` to detect byte-range mode**

Find `resolveReadMode` and prepend a check for `offset`:

```typescript
function resolveReadMode(options: NormalizedOptions): ReadMode {
  if (options.offset !== undefined || options.length !== undefined)
    return 'byteRange';
  if (options.head !== undefined) return 'head';
  if (options.tail !== undefined) return 'tail';
  if (options.startLine !== undefined || options.endLine !== undefined)
    return 'range';
  return 'full';
}
```

- [ ] **Step 7: Implement `executeByteRangeRead`**

Add this function before the `READ_MODE_HANDLERS` const:

```typescript
async function executeByteRangeRead(
  context: ReadModeContext
): Promise<ReadFileResult> {
  const start = context.normalized.offset ?? 0;
  const fileSize = context.stats.size;

  if (start >= fileSize) {
    return {
      path: context.validPath,
      content: '',
      truncated: false,
      readMode: 'byteRange',
      offset: start,
      bytesRead: 0,
      reachedEOF: true,
    };
  }

  const { length } = context.normalized;
  let end: number | undefined;
  let reachedEOF: boolean;

  if (length !== undefined) {
    const requestedEnd = start + length - 1; // createReadStream end is inclusive
    if (requestedEnd >= fileSize) {
      end = fileSize - 1;
      reachedEOF = true;
    } else {
      end = requestedEnd;
      reachedEOF = false;
    }
  } else {
    // No length → read to EOF
    reachedEOF = true;
  }

  const stream = context.handle.createReadStream({
    encoding: context.normalized.encoding,
    start,
    ...(end !== undefined ? { end } : {}),
  });

  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as string);
    assertNotAborted(context.normalized.signal);
  }

  const content = chunks.join('');
  const bytesRead = end !== undefined ? end - start + 1 : fileSize - start;

  return {
    path: context.validPath,
    content,
    truncated: false,
    readMode: 'byteRange',
    offset: start,
    ...(length !== undefined ? { length } : {}),
    bytesRead,
    reachedEOF,
  };
}
```

- [ ] **Step 8: Register `byteRange` in `READ_MODE_HANDLERS`**

Find the `READ_MODE_HANDLERS` const and add the new entry:

```typescript
const READ_MODE_HANDLERS = {
  head: executeHeadRead,
  range: executeRangeRead,
  full: executeFullRead,
  tail: executeTailRead,
  byteRange: executeByteRangeRead,
} as const satisfies Record<
  ReadMode,
  (context: ReadModeContext) => Promise<ReadFileResult>
>;
```

- [ ] **Step 9: Run type-check**

```bash
node scripts/tasks.mjs --quick
```

Expected: No errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/fs-helpers.ts
git commit -m "feat(fs-helpers): add byteRange read mode with offset/length support"
```

---

## Task 3: Byte-range reads — Tool layer wiring

**Files:**

- Modify: `src/tools/read.ts`

- [ ] **Step 1: Update `buildReadOptions` to forward `offset` and `length`**

Find `buildReadOptions` and add two new `assignDefined` entries:

```typescript
function buildReadOptions(
  args: ReadFileInput,
  signal?: AbortSignal
): Parameters<typeof readFile>[1] {
  const options: Parameters<typeof readFile>[1] = {
    encoding: 'utf-8',
    maxSize: MAX_TEXT_FILE_SIZE,
    skipBinary: true,
  };

  return assignDefined(options, {
    signal,
    head: args.head,
    tail: args.tail,
    startLine: args.startLine,
    endLine: args.endLine,
    offset: args.offset, // NEW
    length: args.length, // NEW
  });
}
```

- [ ] **Step 2: Update `toStructuredReadFileResult` to include byte-range fields**

Find `toStructuredReadFileResult` and add the new fields to the `assignDefined` call:

```typescript
function toStructuredReadFileResult(
  result: ReadFileHandlerResult
): ReadFileOutput {
  const structured: ReadFileOutput = {
    ok: true,
    path: result.path,
    content: result.content,
  };

  return assignDefined(structured, {
    continuation: buildReadContinuation(result),
    totalLines: result.totalLines,
    head: result.head,
    tail: result.tail,
    startLine: result.startLine,
    endLine: result.endLine,
    linesRead: result.linesRead,
    hasMoreLines: result.hasMoreLines ? true : undefined,
    // Byte-range fields
    offset: result.offset,
    bytesRead: result.bytesRead,
    reachedEOF: result.reachedEOF,
  });
}
```

- [ ] **Step 3: Update `buildReadContinuation` to skip continuation for byte-range reads**

Find `buildReadContinuation` and add a guard at the top. The function currently uses `hasMoreLines` to decide whether to emit continuation. Byte-range reads set `hasMoreLines: undefined`, so no continuation is emitted. No changes needed here — this already works correctly.

Verify by reading the function:

```
if (!result.hasMoreLines) return undefined;
```

This guard means `byteRange` results (which never set `hasMoreLines`) will correctly return `undefined`. No change required.

- [ ] **Step 4: Update `buildReadProgressMessage` to label byte-range reads**

Find the function and add a byte-range branch before the final return:

```typescript
function buildReadProgressMessage(args: ReadFileInput): string {
  const name = basename(args.path);
  if (args.offset !== undefined) {
    const end = args.length !== undefined ? args.offset + args.length - 1 : '…';
    return `${READ_TOOL_LABEL}: ${name} [bytes ${args.offset}–${String(end)}]`;
  }
  if (args.startLine !== undefined) {
    const end = args.endLine ?? '…';
    return `${READ_TOOL_LABEL}: ${name} [lines ${args.startLine}–${end}]`;
  }
  if (args.head !== undefined)
    return `${READ_TOOL_LABEL}: ${name} [head ${args.head}]`;
  if (args.tail !== undefined)
    return `${READ_TOOL_LABEL}: ${name} [tail ${args.tail}]`;
  return `${READ_TOOL_LABEL}: ${name}`;
}
```

- [ ] **Step 5: Update `buildReadCompletionMessage` to handle byte-range results**

Find the function and add a byte-range branch just after the `if (result.isError)` check:

```typescript
function buildReadCompletionMessage(
  args: ReadFileInput,
  result: ToolResult<ReadFileOutput>
): string {
  const name = basename(args.path);
  if (result.isError)
    return `${READ_TOOL_LABEL}: ${name} • ${result.errorCode}`;

  const structured = result.structuredContent;

  // NEW: byte-range path
  if (structured.offset !== undefined) {
    return `${READ_TOOL_LABEL}: ${name} • ${String(structured.bytesRead ?? 0)} bytes @ ${String(structured.offset)}`;
  }

  const lines = structured.linesRead ?? structured.totalLines;
  // ... rest of existing branches unchanged ...
}
```

- [ ] **Step 6: Update tool description to mention byte-range**

Find `READ_FILE_TOOL.description` and update:

```typescript
description:
  'Read a text file. Use head/tail/startLine/endLine for partial line reads; use offset/length for byte-range reads; use read_many for batches.',
```

- [ ] **Step 7: Run type-check + build**

```bash
node scripts/tasks.mjs --quick
```

Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add src/tools/read.ts
git commit -m "feat(read): wire offset/length byte-range reads through tool layer"
```

---

## Task 4: Byte-range reads — Integration tests

**Files:**

- Modify: `__tests__/tools/read-write.test.ts`

- [ ] **Step 1: Write failing tests for byte-range reads**

Add a new `describe` block after the existing `'read tool'` describe block:

```typescript
describe('read tool — byte-range', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    // 'ABCDEFGHIJ' = 10 bytes
    file = join(env.tmpDir, 'byte-test.txt');
    await writeFile(file, 'ABCDEFGHIJ', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('reads a specific byte range', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, offset: 2, length: 3 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['content'], 'CDE');
    assert.equal(sc['bytesRead'], 3);
    assert.equal(sc['offset'], 2);
    assert.equal(sc['reachedEOF'], false);
  });

  it('sets reachedEOF when length exceeds file size', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, offset: 8, length: 100 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['content'], 'IJ');
    assert.equal(sc['bytesRead'], 2);
    assert.equal(sc['reachedEOF'], true);
  });

  it('reads to EOF when length is omitted', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, offset: 5 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['content'], 'FGHIJ');
    assert.equal(sc['reachedEOF'], true);
  });

  it('returns empty content when offset is past EOF', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, offset: 999 },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['content'], '');
    assert.equal(sc['bytesRead'], 0);
    assert.equal(sc['reachedEOF'], true);
  });

  it('rejects mixing offset with startLine', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: file, offset: 0, startLine: 1 },
    });
    assertToolError(raw);
  });
});
```

- [ ] **Step 2: Run failing tests to verify they fail as expected**

```bash
node --test --import tsx/esm __tests__/tools/read-write.test.ts
```

Expected: The 5 new tests FAIL (byte-range params not yet validated/routed before schema is applied).

- [ ] **Step 3: Run tests again now that implementation is complete**

```bash
node --test --import tsx/esm __tests__/tools/read-write.test.ts
```

Expected: All tests PASS.

- [ ] **Step 4: Run the full test suite**

```bash
node scripts/tasks.mjs
```

Expected: All tests PASS, no lint errors.

- [ ] **Step 5: Commit**

```bash
git add __tests__/tools/read-write.test.ts
git commit -m "test(read): add byte-range read integration tests"
```

---

## Task 5: Asymmetric context — Schema & options layer

**Files:**

- Modify: `src/schemas/inputs.ts`
- Modify: `src/lib/file-operations/search.ts`

- [ ] **Step 1: Add `contextBefore` and `contextAfter` to `GrepInputSchema` in `src/schemas/inputs.ts`**

Find the `contextLines` field in `GrepInputSchema` and add two new fields after it:

```typescript
contextLines: z
  .int32()
  .min(0)
  .max(20)
  .optional()
  .describe('Lines of context around each match (symmetric; overridden by contextBefore/contextAfter)'),
contextBefore: z
  .int32()
  .min(0)
  .max(20)
  .optional()
  .describe('Lines of context before each match (overrides contextLines for before)'),
contextAfter: z
  .int32()
  .min(0)
  .max(20)
  .optional()
  .describe('Lines of context after each match (overrides contextLines for after)'),
```

- [ ] **Step 2: Add `contextBefore` and `contextAfter` to `SearchOptionsSchema` in `src/lib/file-operations/search.ts`**

Find `SearchOptionsSchema` and add two new fields alongside `contextLines`:

```typescript
const SearchOptionsSchema = z.strictObject({
  filePattern: SafeFilePatternSchema,
  excludePatterns: z.array(z.string()),
  caseSensitive: z.boolean(),
  maxResults: z.int().min(0),
  maxFileSize: z.int().min(0),
  maxFilesScanned: z.int().min(0),
  timeoutMs: z.int().min(0),
  skipBinary: z.boolean(),
  contextLines: z.int().min(0),
  contextBefore: z.int().min(0), // NEW
  contextAfter: z.int().min(0), // NEW
  wholeWord: z.boolean(),
  isLiteral: z.boolean(),
  includeHidden: z.boolean(),
  baseNameMatch: z.boolean(),
  caseSensitiveFileMatch: z.boolean(),
});
```

- [ ] **Step 3: Add defaults for the new fields in `DEFAULTS`**

Find the `DEFAULTS` const and add:

```typescript
const DEFAULTS: ResolvedOptions = {
  filePattern: '**/*',
  excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
  caseSensitive: false,
  maxResults: SEARCH_CONTENT_MAX_RESULTS,
  maxFileSize: MAX_SEARCHABLE_FILE_SIZE,
  maxFilesScanned: DEFAULT_SEARCH_MAX_FILES,
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  skipBinary: true,
  contextLines: 0,
  contextBefore: 0, // NEW
  contextAfter: 0, // NEW
  wholeWord: false,
  isLiteral: true,
  includeHidden: false,
  baseNameMatch: false,
  caseSensitiveFileMatch: true,
};
```

- [ ] **Step 4: Add `contextBefore`/`contextAfter` to `ScanFileOptions`**

Find `interface ScanFileOptions` and add two new fields:

```typescript
interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
  contextBefore: number; // NEW
  contextAfter: number; // NEW
}
```

- [ ] **Step 5: Update `buildScanOptions` to populate the new fields**

Find `buildScanOptions` and add the new fields:

```typescript
function buildScanOptions(opts: ResolvedOptions): ScanFileOptions {
  return {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
    contextBefore: opts.contextBefore, // NEW
    contextAfter: opts.contextAfter, // NEW
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add src/schemas/inputs.ts src/lib/file-operations/search.ts
git commit -m "feat(schemas,search): add contextBefore/contextAfter fields"
```

---

## Task 6: Asymmetric context — ContextBuffer refactor

**Files:**

- Modify: `src/lib/file-operations/search.ts`

- [ ] **Step 1: Refactor `ContextBuffer` constructor to accept separate before/after counts**

Find the `ContextBuffer` class and update:

1. Rename `capacity` → `beforeCapacity`
2. Add `afterCapacity` property
3. Update constructor signature

```typescript
class ContextBuffer {
  private readonly beforeCapacity: number;
  private readonly afterCapacity: number;
  private buffer: string[]; // Ring buffer fixed size (before-context)
  private head = 0; // Next write index
  private size = 0; // Current count of items
  private pending: PendingContext[] = [];

  constructor(contextBefore: number, contextAfter: number) {
    this.beforeCapacity = Math.max(0, contextBefore);
    this.afterCapacity = Math.max(0, contextAfter);
    this.buffer = new Array<string>(this.beforeCapacity);
  }

  add(line: string): void {
    // 1. Fill Pending 'After' Contexts
    if (this.pending.length > 0) {
      let writeIndex = 0;
      for (const p of this.pending) {
        if (p.remaining > 0) {
          p.buffer.push(line);
          p.remaining--;
        }
        if (p.remaining > 0) {
          this.pending[writeIndex] = p;
          writeIndex++;
        }
      }
      this.pending.length = writeIndex;
    }

    // 2. Maintain 'Before' Buffer (ring buffer)
    if (this.beforeCapacity > 0) {
      this.buffer[this.head] = line;
      this.head = (this.head + 1) % this.beforeCapacity;
      if (this.size < this.beforeCapacity) this.size++;
    }
  }

  snapshotBefore(): string[] {
    if (this.size === 0) return [];
    const result = new Array<string>(this.size);

    if (this.size < this.beforeCapacity) {
      for (let i = 0; i < this.size; i++) {
        result[i] = this.buffer[i] ?? '';
      }
      return result;
    }

    let outIndex = 0;
    for (let i = this.head; i < this.beforeCapacity; i++) {
      result[outIndex] = this.buffer[i] ?? '';
      outIndex++;
    }
    for (let i = 0; i < this.head; i++) {
      result[outIndex] = this.buffer[i] ?? '';
      outIndex++;
    }
    return result;
  }

  scheduleAfter(): string[] {
    if (this.afterCapacity === 0) return [];
    const buffer: string[] = [];
    this.pending.push({ buffer, remaining: this.afterCapacity });
    return buffer;
  }
}
```

- [ ] **Step 2: Update `readMatches` to resolve effective before/after and pass to `ContextBuffer`**

Find the `readMatches` function. Replace:

```typescript
const hasContext = options.contextLines > 0;
const ctx = hasContext ? new ContextBuffer(options.contextLines) : undefined;
```

With:

```typescript
const effectiveBefore =
  options.contextBefore > 0 ? options.contextBefore : options.contextLines;
const effectiveAfter =
  options.contextAfter > 0 ? options.contextAfter : options.contextLines;
const hasContext = effectiveBefore > 0 || effectiveAfter > 0;
const ctx = hasContext
  ? new ContextBuffer(effectiveBefore, effectiveAfter)
  : undefined;
```

- [ ] **Step 3: Run type-check**

```bash
node scripts/tasks.mjs --quick
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/file-operations/search.ts
git commit -m "feat(search): refactor ContextBuffer for asymmetric contextBefore/contextAfter"
```

---

## Task 7: Asymmetric context — Tool wiring & tests

**Files:**

- Modify: `src/tools/search-content.ts`
- Modify: `__tests__/tools/search.test.ts`

- [ ] **Step 1: Wire `contextBefore`/`contextAfter` through `executeSearch` in `src/tools/search-content.ts`**

Find the `options: SearchContentOptions` object inside `executeSearch`. Currently:

```typescript
const options: SearchContentOptions = {
  includeHidden: args.includeHidden,
  excludePatterns,
  filePattern: args.pattern ?? '**/*',
  caseSensitive: args.caseSensitive,
  wholeWord: args.wholeWord,
  ...(args.contextLines !== undefined
    ? { contextLines: args.contextLines }
    : {}),
  maxResults: args.maxResults,
  isLiteral: !args.isRegex,
  ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
  ...(signal ? { signal } : {}),
  ...(onProgress ? { onProgress } : {}),
};
```

Add two new conditional spreads:

```typescript
const options: SearchContentOptions = {
  includeHidden: args.includeHidden,
  excludePatterns,
  filePattern: args.pattern ?? '**/*',
  caseSensitive: args.caseSensitive,
  wholeWord: args.wholeWord,
  ...(args.contextLines !== undefined
    ? { contextLines: args.contextLines }
    : {}),
  ...(args.contextBefore !== undefined
    ? { contextBefore: args.contextBefore }
    : {}),
  ...(args.contextAfter !== undefined
    ? { contextAfter: args.contextAfter }
    : {}),
  maxResults: args.maxResults,
  isLiteral: !args.isRegex,
  ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
  ...(signal ? { signal } : {}),
  ...(onProgress ? { onProgress } : {}),
};
```

- [ ] **Step 2: Run type-check**

```bash
node scripts/tasks.mjs --quick
```

Expected: No errors.

- [ ] **Step 3: Write failing tests for asymmetric context**

Add a new test to the `'grep tool'` describe block in `__tests__/tools/search.test.ts`:

```typescript
it('returns asymmetric context with contextBefore/contextAfter', async () => {
  const file = join(env.tmpDir, 'ctx-test.txt');
  await writeFile(file, 'before2\nbefore1\nMATCH\nafter1\nafter2\n', 'utf8');

  const raw = await env.client.callTool({
    name: 'grep',
    arguments: {
      path: file,
      searchPattern: 'MATCH',
      contextBefore: 2,
      contextAfter: 1,
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  const matches = sc['matches'] as Array<{
    content: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.contextBefore, ['before2', 'before1']);
  assert.deepEqual(matches[0]?.contextAfter, ['after1']);
});

it('returns only after-context when contextBefore is 0', async () => {
  const file = join(env.tmpDir, 'ctx-after.txt');
  await writeFile(file, 'before\nMATCH\nafter1\nafter2\n', 'utf8');

  const raw = await env.client.callTool({
    name: 'grep',
    arguments: {
      path: file,
      searchPattern: 'MATCH',
      contextBefore: 0,
      contextAfter: 2,
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  const matches = sc['matches'] as Array<{
    contextBefore?: string[];
    contextAfter?: string[];
  }>;
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.contextBefore, undefined);
  assert.deepEqual(matches[0]?.contextAfter, ['after1', 'after2']);
});
```

- [ ] **Step 4: Run search tests to verify they pass**

```bash
node --test --import tsx/esm __tests__/tools/search.test.ts
```

Expected: All tests PASS including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-content.ts __tests__/tools/search.test.ts
git commit -m "feat(grep): wire contextBefore/contextAfter and add tests"
```

---

## Task 8: Fuzzy search

**Files:**

- Modify: `src/schemas/inputs.ts`
- Modify: `src/lib/file-operations/search.ts`
- Modify: `src/tools/search-content.ts`
- Modify: `__tests__/tools/search.test.ts`

- [ ] **Step 1: Add `fuzzy` field to `GrepInputSchema` in `src/schemas/inputs.ts`**

Find `GrepInputSchema` and add after `wholeWord`:

```typescript
fuzzy: defaultFalseBoolean(
  'Approximate string matching (Levenshtein-based; requires pattern to scope files when searching directories)'
),
```

- [ ] **Step 2: Add fuzzy constants and `isFuzzyMatch` helper in `src/lib/file-operations/search.ts`**

At the top of the file near other constants, add:

```typescript
/**
 * Max files to scan when fuzzy=true without a file glob narrower than '**\/*'.
 * Prevents accidental full-tree fuzzy scans.
 */
const MAX_FUZZY_FILES = 200;

/**
 * Returns true if `text` approximately contains `pattern` using a simple
 * sliding-window Levenshtein distance check per window of pattern.length*1.5.
 * Only considers the best-fit window, not full string distance.
 */
function isFuzzyMatch(
  text: string,
  pattern: string,
  caseSensitive: boolean
): boolean {
  const t = caseSensitive ? text : text.toLowerCase();
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  if (p.length === 0) return false;
  if (t.includes(p)) return true; // fast path: exact substring

  const winLen = Math.min(Math.ceil(p.length * 1.5), t.length);
  const maxDist = Math.max(1, Math.floor(p.length / 4));

  for (let start = 0; start <= t.length - p.length; start++) {
    const win = t.slice(start, start + winLen);
    if (levenshtein(win, p) <= maxDist) return true;
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j] ?? 0, dp[j - 1] ?? 0);
      prev = temp;
    }
  }
  return dp[n] ?? 0;
}
```

- [ ] **Step 3: Add `fuzzy` to `SearchContentOptions`**

`SearchContentOptions extends Partial<ResolvedOptions>` — since `fuzzy` is NOT in `ResolvedOptions` (it affects the matcher, not the scan config), add it as a standalone field:

```typescript
export interface SearchContentOptions extends Partial<ResolvedOptions> {
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
  maxDepth?: number;
  fuzzy?: boolean; // NEW
}
```

- [ ] **Step 4: Apply the `MAX_FUZZY_FILES` guard in `searchContent` (the exported function)**

Find the `searchContent` exported function. After `const opts = resolveOptions(options);`, add:

```typescript
if (options.fuzzy === true && opts.filePattern === '**/*') {
  opts.maxFilesScanned = Math.min(opts.maxFilesScanned, MAX_FUZZY_FILES);
}
```

Note: `opts` is typed as `ResolvedOptions` (returned by `resolveOptions`) which uses `z.infer`. Since `ResolvedOptions` doesn't have `fuzzy`, keep reading `options.fuzzy` directly from the raw options argument.

- [ ] **Step 5: Thread `fuzzy` through `ScanFileOptions` and `readMatches`**

Add `fuzzy: boolean` to `ScanFileOptions`:

```typescript
interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
  contextBefore: number;
  contextAfter: number;
  fuzzy: boolean; // NEW
}
```

Update `buildScanOptions`:

```typescript
function buildScanOptions(
  opts: ResolvedOptions,
  fuzzy: boolean
): ScanFileOptions {
  return {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
    contextBefore: opts.contextBefore,
    contextAfter: opts.contextAfter,
    fuzzy,
  };
}
```

Find every call to `buildScanOptions(opts)` and pass the fuzzy flag. The call site is inside `scanDirectory` or `searchSingleFile` — trace how opts flows from `searchContent` to find the call site, then pass `options.fuzzy ?? false` alongside `opts`.

Update `readMatches` to check `options.fuzzy` when the regular matcher returns 0:

```typescript
// Inside the line-processing loop, after `const matchCount = matcher(rawLine);`
const effectiveMatchCount =
  matchCount > 0
    ? matchCount
    : options.fuzzy &&
        isFuzzyMatch(rawLine, pattern, options.caseSensitive ?? false)
      ? 1
      : 0;
```

Replace subsequent uses of `matchCount` in the body with `effectiveMatchCount`.

Note: `pattern` here is the `searchPattern` string argument to `readMatches`. Check the exact function signature — it is `readMatches(handle, requestedPath, matcher, options, maxMatches, isCancelled, signal)`. The raw pattern string needs to be threaded through as well. Find where `readMatches` is called and check what `pattern` is available in scope — it is available in the outer `scanFile` function. Add `searchPattern: string` to `ScanFileOptions` or pass it as a separate argument to `readMatches`.

The cleanest approach: add `searchPattern: string` to `ScanFileOptions`:

```typescript
interface ScanFileOptions {
  maxFileSize: number;
  skipBinary: boolean;
  contextLines: number;
  contextBefore: number;
  contextAfter: number;
  fuzzy: boolean;
  searchPattern: string; // NEW: needed for fuzzy matching
}
```

And populate it in `buildScanOptions`:

```typescript
function buildScanOptions(
  opts: ResolvedOptions,
  pattern: string,
  fuzzy: boolean
): ScanFileOptions {
  return {
    maxFileSize: opts.maxFileSize,
    skipBinary: opts.skipBinary,
    contextLines: opts.contextLines,
    contextBefore: opts.contextBefore,
    contextAfter: opts.contextAfter,
    fuzzy,
    searchPattern: pattern,
  };
}
```

Find the call site of `buildScanOptions` and update it to pass `pattern` (the search pattern string) and `options.fuzzy ?? false`.

- [ ] **Step 6: Wire `fuzzy` through `executeSearch` in `src/tools/search-content.ts`**

Add to the options object:

```typescript
...(args.fuzzy ? { fuzzy: true } : {}),
```

- [ ] **Step 7: Run type-check**

```bash
node scripts/tasks.mjs --quick
```

Expected: No errors.

- [ ] **Step 8: Write failing tests for fuzzy search**

Add to the `'grep tool'` describe block in `__tests__/tools/search.test.ts`:

```typescript
it('fuzzy match finds near-misspelled terms', async () => {
  const file = join(env.tmpDir, 'fuzzy.txt');
  await writeFile(file, 'function calculateHash\nno match here\n', 'utf8');

  const raw = await env.client.callTool({
    name: 'grep',
    arguments: {
      path: file,
      searchPattern: 'calculateHsh', // missing 'a'
      fuzzy: true,
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.ok((sc['totalMatches'] as number) >= 1);
});

it('fuzzy:false does not match misspelled terms', async () => {
  const file = join(env.tmpDir, 'nofuzzy.txt');
  await writeFile(file, 'function calculateHash\n', 'utf8');

  const raw = await env.client.callTool({
    name: 'grep',
    arguments: {
      path: file,
      searchPattern: 'calculateHsh',
      fuzzy: false,
    },
  });
  assertOk(raw);
  const sc = getStructured(raw);
  assert.equal(sc['totalMatches'], 0);
});
```

- [ ] **Step 9: Run all tests**

```bash
node scripts/tasks.mjs
```

Expected: All tests PASS, no lint errors.

- [ ] **Step 10: Commit**

```bash
git add src/schemas/inputs.ts src/lib/file-operations/search.ts src/tools/search-content.ts __tests__/tools/search.test.ts
git commit -m "feat(grep): add fuzzy matching with Levenshtein distance and file-count safeguard"
```

---

## Task 9: Final validation

- [ ] **Step 1: Run full build + test suite + lint**

```bash
node scripts/tasks.mjs
```

Expected: Format, lint, type-check, tests, and build all pass.

- [ ] **Step 2: Check schema snapshot tests are still valid**

```bash
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts
```

If any snapshot fails, update them:

```bash
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts --update-snapshots
git add __tests__/schemas/__snapshots__/
git commit -m "test(snapshots): update for new byte-range and fuzzy schema fields"
```

- [ ] **Step 3: Check contract test still passes**

```bash
node --test --import tsx/esm __tests__/contract.test.ts
```

Expected: PASS. (No new tools were added; only params were added to existing tools. The contract test checks annotations and counts, so it should not require changes unless a tool's `taskSupport` or annotations changed.)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: precision read (byte-range) + enhanced grep (asymmetric context, fuzzy)"
```
