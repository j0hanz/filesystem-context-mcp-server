# MCP SDK Type Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps identified in the SDK-usage audit by adopting available `@modelcontextprotocol/server@2.0.0-alpha.2` exports, tightening internal types to remove `as unknown as` casts, and aligning the on-the-wire shape with the MCP spec.

**Architecture:** Seven small, independent refactors across the transport layer, the tool-definition engine, the schema bridge, the roots-management code, and the observability metadata. No behavioural change for clients except (a) stricter inbound-body validation on HTTP, (b) `Root.uri` now requires `file://` prefix, (c) trace-context keys in `_meta` move under an `io.opentelemetry/` namespace.

**Tech Stack:** TypeScript 6, Zod v4, `@modelcontextprotocol/server` 2.0.0-alpha.2, Node.js >=24, `node:test` runner.

---

## Reality check on the upstream SDK reference

The audit referenced files from upstream commit `2c0c481` of `modelcontextprotocol/typescript-sdk`. That tree introduces `specTypeSchemas`, `isSpecType`, `isCallToolResult`, `RootSchema`, `ListRootsResultSchema`, and `JSONObjectSchema/JSONValueSchema`. **These exports are NOT yet present in the installed `@modelcontextprotocol/server@2.0.0-alpha.2`.** Verified exports we can rely on now:

| Export                                                                                              | Available in alpha-2? |
| --------------------------------------------------------------------------------------------------- | --------------------- |
| `JSONRPC_VERSION`                                                                                   | yes                   |
| `parseJSONRPCMessage`                                                                               | yes                   |
| `isJSONRPCRequest` / `isJSONRPCNotification` / `isJSONRPCErrorResponse` / `isJSONRPCResultResponse` | yes                   |
| `isInitializeRequest` / `isInitializedNotification` / `isTaskAugmentedRequestParams`                | yes                   |
| `assertCompleteRequestPrompt` / `assertCompleteRequestResourceTemplate`                             | yes                   |
| `specTypeSchemas` / `isSpecType` / `isCallToolResult`                                               | **no** (post-alpha-2) |
| `RootSchema` / `ListRootsResultSchema` / `ToolSchema` / `JSONObjectSchema`                          | **no** (post-alpha-2) |

This plan only schedules work against verified exports. A follow-up task (Task 8) bookmarks the future migration once those land.

---

## File map

| File                                                                                                 | Responsibility                                                   | Tasks touching it |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- |
| [src/transport.ts](src/transport.ts)                                                                 | HTTP/stdio JSON-RPC envelopes & body validation                  | 1, 2              |
| [src/server.ts](src/server.ts)                                                                       | Local `RootSchema`, `RootsResponseSchema`, `isRoot`              | 3                 |
| [src/tools/define.ts](src/tools/define.ts)                                                           | Tool registration, `coreHandler` typing, experimental.tasks cast | 4, 5, 6           |
| [src/schema.ts](src/schema.ts)                                                                       | `toMcpSchema` Standard Schema + JSON-Schema bridge               | 6                 |
| [src/tools/\_helpers.ts](src/tools/_helpers.ts)                                                      | `ToolContext`, `TracingMeta`                                     | 7                 |
| [src/core/errors.ts](src/core/errors.ts)                                                             | `TraceContext` writer, `_meta` emission                          | 7                 |
| [src/core/observability.ts](src/core/observability.ts)                                               | `TraceContext` reader, propagation                               | 7                 |
| [\_\_tests\_\_/...](__tests__/)                                                                      | New tests for each behavioural change                            | every task        |
| [docs/superpowers/plans/2026-05-10-...](docs/superpowers/plans/2026-05-10-mcp-sdk-type-alignment.md) | This plan                                                        | —                 |

---

## Pre-flight

- [ ] **Step 0.1: Verify clean working tree**

Run: `git status --short`
Expected: empty (or only this plan file).

- [ ] **Step 0.2: Verify the SDK exports we need exist**

Run:

```powershell
$dts = Get-Content node_modules/@modelcontextprotocol/server/dist/index.d.mts -Raw
foreach ($p in 'JSONRPC_VERSION','parseJSONRPCMessage','isJSONRPCRequest','isJSONRPCNotification','isJSONRPCErrorResponse','isJSONRPCResultResponse') { if ($dts -match $p) { "FOUND: $p" } else { "MISSING: $p" } }
```

Expected: every line says `FOUND:`.

- [ ] **Step 0.3: Establish baseline test pass**

Run: `npm run test`
Expected: all tests pass.

---

## Task 1: Replace `'2.0'` literal with `JSONRPC_VERSION`

**Files:**

- Modify: [src/transport.ts](src/transport.ts) — `sendJsonRpcError` (around line 162), `bearerAuthMiddleware` 401 body (around line 290)
- Test: `__tests__/unit/transport-jsonrpc-version.test.ts` (new)

**Why:** The codebase hard-codes `'2.0'` in two error envelopes. The SDK exports `JSONRPC_VERSION` (verified). Using it removes string drift if the spec ever bumps.

- [ ] **Step 1.1: Write the failing test**

Create `__tests__/unit/transport-jsonrpc-version.test.ts`:

```ts
import { JSONRPC_VERSION } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('transport.ts uses JSONRPC_VERSION constant, not the "2.0" string literal', async () => {
  const src = await readFile(new URL('../../src/transport.ts', import.meta.url), 'utf8');
  // Allow JSONRPC_VERSION imports/usages, ban bare '2.0' or "2.0" literals in this file.
  const literalRe = /['"]2\.0['"]/g;
  const hits = src.match(literalRe) ?? [];
  assert.equal(
    hits.length,
    0,
    `Found ${hits.length} bare '2.0' literals in transport.ts; use JSONRPC_VERSION instead.`,
  );
  assert.equal(JSONRPC_VERSION, '2.0', 'Sanity: SDK constant equals 2.0');
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/transport-jsonrpc-version.test.ts"`
Expected: FAIL — at least 2 hits found.

- [ ] **Step 1.3: Add `JSONRPC_VERSION` to imports and replace literals**

In [src/transport.ts](src/transport.ts) update the import block (existing import is around lines 4-10):

```ts
import {
  isInitializeRequest,
  JSONRPC_VERSION,
  type JSONRPCMessage,
  ProtocolErrorCode,
  StdioServerTransport,
} from '@modelcontextprotocol/server';
```

In `sendJsonRpcError`:

```ts
function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      error: { code, message },
      id: null,
    }),
  );
}
```

In `bearerAuthMiddleware` (401 response body):

```ts
res.end(
  JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    error: { code: JSON_RPC_SERVER_ERROR, message: 'Unauthorized' },
    id: null,
  }),
);
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `node --test --import tsx/esm "__tests__/unit/transport-jsonrpc-version.test.ts"`
Expected: PASS.

- [ ] **Step 1.5: Run full check**

Run: `node scripts/tasks.mjs --quick`
Expected: format, lint, type-check, knip all pass.

- [ ] **Step 1.6: Commit**

```bash
git add src/transport.ts __tests__/unit/transport-jsonrpc-version.test.ts
git commit -m "refactor(transport): use JSONRPC_VERSION constant instead of '2.0' literal"
```

---

## Task 2: Validate inbound JSON-RPC bodies with `parseJSONRPCMessage`

**Files:**

- Modify: [src/transport.ts](src/transport.ts) — `handlePostMcp` (around line 519)
- Test: `__tests__/unit/transport-body-validation.test.ts` (new)

**Why:** Today the POST handler only branches on `isInitializeRequest`; any malformed JSON-RPC message that isn't an initialize request is forwarded to the transport which then returns a generic internal error. Using `parseJSONRPCMessage` gives a clean `-32600 Invalid Request` boundary.

The SDK `parseJSONRPCMessage(value): JSONRPCMessage` throws on invalid input. The existing flow is: parse JSON body via Express → check session → if no session, must be `initialize`. We add an explicit shape check that runs BEFORE the session lookup.

- [ ] **Step 2.1: Write the failing test**

Create `__tests__/unit/transport-body-validation.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('transport.ts imports parseJSONRPCMessage from @modelcontextprotocol/server', async () => {
  const src = await readFile(new URL('../../src/transport.ts', import.meta.url), 'utf8');
  assert.match(src, /parseJSONRPCMessage/, 'expected parseJSONRPCMessage usage in transport.ts');
});

test('parseJSONRPCMessage throws on malformed body', async () => {
  const { parseJSONRPCMessage } = await import('@modelcontextprotocol/server');
  assert.throws(() => parseJSONRPCMessage({ not: 'jsonrpc' }));
  assert.throws(() => parseJSONRPCMessage(null));
  // Valid request shape should not throw
  assert.doesNotThrow(() =>
    parseJSONRPCMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  );
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/transport-body-validation.test.ts"`
Expected: FAIL on the first assertion (no `parseJSONRPCMessage` usage yet).

- [ ] **Step 2.3: Add validation in `handlePostMcp`**

In [src/transport.ts](src/transport.ts) add `parseJSONRPCMessage` to the import block:

```ts
import {
  isInitializeRequest,
  JSONRPC_VERSION,
  type JSONRPCMessage,
  parseJSONRPCMessage,
  ProtocolErrorCode,
  StdioServerTransport,
} from '@modelcontextprotocol/server';
```

Update `handlePostMcp` body — add validation immediately after `getSessionId(req)`:

```ts
async function handlePostMcp(
  req: Request,
  res: Response,
  options: ServerOptions,
  registry: HttpSessionRegistry,
  eventStore: InMemoryEventStore,
): Promise<void> {
  try {
    // Validate JSON-RPC envelope shape early. Batch arrays are rejected by the
    // SDK; if present we surface a clean -32600 instead of a 500 from inside
    // the transport layer.
    const body: unknown = req.body;
    if (Array.isArray(body)) {
      sendJsonRpcError(
        res,
        400,
        JSON_RPC_INVALID_REQUEST,
        'Batch JSON-RPC requests are not supported',
      );
      return;
    }
    try {
      parseJSONRPCMessage(body);
    } catch {
      sendJsonRpcError(res, 400, JSON_RPC_INVALID_REQUEST, 'Invalid JSON-RPC message');
      return;
    }

    const sessionId = getSessionId(req);
    if (sessionId) {
      const session = registry.getOrRespondNotFound(sessionId, res);
      if (session) {
        await handleSessionTransportRequest(session, req, res, body);
      }
      return;
    }
    if (!isInitializeRequest(body)) {
      sendJsonRpcError(
        res,
        400,
        JSON_RPC_SERVER_ERROR,
        'Bad Request: No valid session ID provided',
      );
      return;
    }
    const maxSessions = parseEnvInt('FILESYSTEM_MCP_MAX_HTTP_SESSIONS', 100, 1, 10_000);
    if (registry.size() >= maxSessions) {
      sendJsonRpcError(res, 503, JSON_RPC_SERVER_ERROR, 'Too many sessions');
      return;
    }
    const session = await createHttpSession(options, registry, eventStore);
    await handleSessionTransportRequest(session, req, res, body);
  } catch (error) {
    Logger.error('[HTTP] Error handling POST request:', formatUnknownErrorMessage(error));
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
    }
  }
}
```

- [ ] **Step 2.4: Run tests**

Run: `node --test --import tsx/esm "__tests__/unit/transport-body-validation.test.ts" "__tests__/http.test.ts"`
Expected: PASS — including the existing http.test.ts which already exercises initialize flows.

- [ ] **Step 2.5: Run full check**

Run: `node scripts/tasks.mjs --quick`
Expected: clean.

- [ ] **Step 2.6: Commit**

```bash
git add src/transport.ts __tests__/unit/transport-body-validation.test.ts
git commit -m "feat(transport): validate inbound JSON-RPC bodies with parseJSONRPCMessage"
```

---

## Task 3: Tighten local `RootSchema` to enforce `file://` URI prefix

**Files:**

- Modify: [src/server.ts](src/server.ts) — `RootSchema` (around line 69-75)
- Test: `__tests__/unit/roots-manager.test.ts` (extend existing)

**Why:** The MCP spec requires `Root.uri` to start with `file://` (the upstream `RootSchema` uses `z.string().startsWith('file://')`). Our local mini-schema accepts any string. Until the SDK exports `RootSchema`, we mirror the spec rule locally; when it ships we can swap (Task 8).

`extractRoots` already filters via `safeParse` and a separate `isRoot` predicate, so adding the prefix rule into `RootSchema` is the right place — invalid roots get filtered silently (matches existing behaviour for missing `uri`).

- [ ] **Step 3.1: Write the failing test**

Append to `__tests__/unit/roots-manager.test.ts` (or create if missing — search first):

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test("server.ts RootSchema enforces 'file://' prefix on uri", async () => {
  const src = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  // The local RootSchema must apply the spec rule.
  assert.match(
    src,
    /uri:\s*z\.string\(\)\s*\.startsWith\(\s*['"]file:\/\/['"]/,
    "expected RootSchema.uri to use z.string().startsWith('file://')",
  );
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/roots-manager.test.ts"`
Expected: FAIL on the new assertion.

- [ ] **Step 3.3: Update `RootSchema` in `src/server.ts`**

Replace the existing block:

```ts
const RootSchema = z.strictObject({
  uri: z.string().startsWith('file://', { error: "Root.uri must start with 'file://'" }),
  name: z.string().optional(),
});

const RootsResponseSchema = z.strictObject({
  roots: z.array(RootSchema).optional(),
});
```

The `isRoot` helper remains as a defensive narrow over `Root` (the SDK type may evolve). No other callers need to change — `extractRoots` already filters out failed-parse cases via `safeParse`.

- [ ] **Step 3.4: Run tests**

Run: `node --test --import tsx/esm "__tests__/unit/roots-manager.test.ts"`
Expected: PASS.

Run the full roots-related suite:
`node --test --import tsx/esm "__tests__/unit/roots-manager.test.ts" "__tests__/security.test.ts"`
Expected: PASS.

- [ ] **Step 3.5: Run full check**

Run: `node scripts/tasks.mjs --quick`
Expected: clean.

- [ ] **Step 3.6: Commit**

```bash
git add src/server.ts __tests__/unit/roots-manager.test.ts
git commit -m "fix(server): RootSchema enforces 'file://' prefix per MCP spec"
```

---

## Task 4: Tighten `coreHandler` return type to `CallToolResult` and drop the `as unknown as` cast

**Files:**

- Modify: [src/tools/define.ts](src/tools/define.ts) — `coreHandler` body (around lines 132-200), `serverCtxHandler` cast (around line 245)
- Test: `__tests__/unit/define-tool.test.ts` (extend existing)

**Why:** [src/tools/define.ts:245](src/tools/define.ts#L245) currently does `(await coreHandler(...)) as unknown as CallToolResult`. The handler's actual return shape is already structurally `CallToolResult` — we just have to declare it so. This removes the cast and lets TypeScript catch shape regressions at compile time.

The current shapes returned from `coreHandler`:

1. `{ isError: true, content: [{ type: 'text', text: string }] }` — server-not-initialized branch.
2. `{ isError: true, content: [...] }` — invalid-input branch.
3. `{ content: ContentBlock[], structuredContent: unknown }` — pre-wrapped tool result.
4. `{ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }` — auto-wrapped result.
5. `{ content, isError: true, errorCode }` — `buildToolErrorResponse` shape.

All five satisfy `CallToolResult`. The fix is to (a) annotate `coreHandler`'s return type as `Promise<CallToolResult>`, (b) drop the cast, (c) add a type-test that imports the inferred return type and asserts assignability.

- [ ] **Step 4.1: Write the failing test**

Append to `__tests__/unit/define-tool.test.ts` (or create if missing — check first with `file_search`):

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('define.ts no longer uses "as unknown as CallToolResult" cast in serverCtxHandler', async () => {
  const src = await readFile(new URL('../../src/tools/define.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    src,
    /as unknown as CallToolResult/,
    'serverCtxHandler return cast must be removed once coreHandler is typed as Promise<CallToolResult>',
  );
});
```

- [ ] **Step 4.2: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"`
Expected: FAIL — pattern still present.

- [ ] **Step 4.3: Annotate `coreHandler` and remove the cast**

In [src/tools/define.ts](src/tools/define.ts) update the `coreHandler` declaration (the function inside `register`):

```ts
      const coreHandler = async (args: unknown, ctx: ToolContext): Promise<CallToolResult> => {
        if (!deps.isInitialized()) {
          return {
            isError: true as const,
            content: [
              { type: 'text' as const, text: 'Server not initialized. Roots unavailable.' },
            ],
          };
        }

        const parsed = def.input.safeParse(args);
        if (!parsed.success) {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: `Invalid input: ${parsed.error.message}` }],
          };
        }
        // ... (rest of body unchanged)
```

Then update `serverCtxHandler` to drop the cast:

```ts
const serverCtxHandler = async (
  args: unknown,
  extra: {
    mcpReq: {
      signal: AbortSignal;
      log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
      elicitInput: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
    };
  },
): Promise<CallToolResult> =>
  coreHandler(args, {
    signal: extra.mcpReq.signal,
    log: async (level: LoggingLevel, data: unknown, logger?: string) =>
      extra.mcpReq.log(level, data, logger),
    elicitInput: (params: ElicitRequestFormParams) => extra.mcpReq.elicitInput(params),
  });
```

If type-check fails on the auto-wrap branch (step 4 in the original handler) because `JSON.stringify(result)` returns `string | undefined`, narrow with a guard:

```ts
const text = typeof result === 'undefined' ? '' : JSON.stringify(result);
return {
  content: [{ type: 'text' as const, text }],
  structuredContent: result as Record<string, unknown>,
};
```

If `buildToolErrorResponse`'s return shape lacks `structuredContent` and TS complains, that is fine — `CallToolResult` makes `structuredContent` optional.

- [ ] **Step 4.4: Run type-check**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 4.5: Run tests**

Run: `node --test --import tsx/esm "__tests__/unit/define-tool.test.ts" "__tests__/tools/read-write.test.ts" "__tests__/tools/task-mode.test.ts"`
Expected: PASS.

- [ ] **Step 4.6: Run full check**

Run: `node scripts/tasks.mjs --quick`
Expected: clean.

- [ ] **Step 4.7: Commit**

```bash
git add src/tools/define.ts __tests__/unit/define-tool.test.ts
git commit -m "refactor(tools): type coreHandler as Promise<CallToolResult>, drop unsafe cast"
```

---

## Task 5: Introduce a typed wrapper for `experimental.tasks.registerToolTask`

**Files:**

- Modify: [src/tools/define.ts](src/tools/define.ts) — interface above `defineTool`, `register` body (around lines 215-225)
- Test: `__tests__/unit/define-tool.test.ts` (extend)

**Why:** The current code reaches into `deps.server.experimental.tasks as unknown as { registerToolTask: ... }` inline. The cast is necessary (alpha-2 doesn't fully type `experimental.tasks`) but should be **named, documented, and centralized** so the rest of the file is cast-free and so the future SDK upgrade is a single delete.

- [ ] **Step 5.1: Write the failing test**

Append to `__tests__/unit/define-tool.test.ts`:

```ts
test('define.ts isolates the experimental.tasks cast in a single typed adapter', async () => {
  const src = await readFile(new URL('../../src/tools/define.ts', import.meta.url), 'utf8');
  const matches = src.match(/experimental\.tasks as unknown as/g) ?? [];
  assert.equal(
    matches.length,
    0,
    'expected zero inline casts; use the typed adapter helper instead',
  );
  assert.match(src, /interface ExperimentalTasksApi/, 'expected a named adapter interface');
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"`
Expected: FAIL.

- [ ] **Step 5.3: Add the adapter and use it**

In [src/tools/define.ts](src/tools/define.ts), add this just below the existing `OrchestratorLike` interface:

```ts
// Local type adapter for experimental.tasks. The published SDK's typings for
// `experimental.tasks.registerToolTask` are incomplete in 2.0.0-alpha.2; the
// interface and `getExperimentalTasks` helper isolate the necessary cast in
// one spot so the rest of this file stays cast-free. Delete once the SDK
// publishes proper typings.
interface ExperimentalTasksApi {
  registerToolTask(name: string, def: unknown, handler: unknown): void;
}

function getExperimentalTasks(server: McpServer): ExperimentalTasksApi {
  return server.experimental.tasks as unknown as ExperimentalTasksApi;
}
```

Replace the inline cast site (around line 218):

```ts
      if (taskMode !== 'forbidden' && deps.orchestrator) {
        const taskHandler = deps.orchestrator.wrapToolTask(coreHandler, { toolName: def.name });
        getExperimentalTasks(deps.server).registerToolTask(
          def.name,
          { ...toolDefShape, execution: { taskSupport: taskMode } },
          taskHandler,
        );
      } else {
```

- [ ] **Step 5.4: Run tests**

Run: `node --test --import tsx/esm "__tests__/unit/define-tool.test.ts" "__tests__/tools/task-mode.test.ts"`
Expected: PASS.

- [ ] **Step 5.5: Run full check**

Run: `node scripts/tasks.mjs --quick`
Expected: clean.

- [ ] **Step 5.6: Commit**

```bash
git add src/tools/define.ts __tests__/unit/define-tool.test.ts
git commit -m "refactor(tools): centralize experimental.tasks cast in typed adapter"
```

---

## Task 6: Have `toMcpSchema` return JSON Schema directly to remove the two casts in `define.ts`

**Files:**

- Modify: [src/schema.ts](src/schema.ts) — `toMcpSchema` (around line 56)
- Modify: [src/tools/define.ts](src/tools/define.ts) — `inputJsonSchema`/`outputJsonSchema` assignment (lines 128-129)
- Test: `__tests__/schemas/json-schema.test.ts` (extend)

**Why:** [src/tools/define.ts:128-129](src/tools/define.ts#L128) accesses the embedded `jsonSchema` via `(inputSchema as unknown as { jsonSchema: object }).jsonSchema`. The cast is only needed because `StandardSchemaWithJSON` doesn't expose a typed `jsonSchema`. Make `toMcpSchema` return the JSON Schema as a properly typed sibling.

- [ ] **Step 6.1: Write the failing test**

Append to `__tests__/schemas/json-schema.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v4';

import { toMcpSchema } from '../../src/schema.js';

test('toMcpSchema returns the JSON Schema as a typed sibling, no cast needed', () => {
  const result = toMcpSchema(z.strictObject({ foo: z.string() }));
  // The new shape: { standard, jsonSchema }
  assert.ok('standard' in result, 'expected standard property');
  assert.ok('jsonSchema' in result, 'expected jsonSchema property');
  const json = result.jsonSchema as Record<string, unknown>;
  assert.equal(json['type'], 'object');
});
```

(Also add a test that `define.ts` no longer contains the embedded-jsonSchema cast.)

```ts
test('define.ts no longer extracts jsonSchema via "as unknown as { jsonSchema: object }"', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../src/tools/define.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /as unknown as \{\s*jsonSchema:\s*object\s*\}/);
});
```

- [ ] **Step 6.2: Run tests to verify they fail**

Run: `node --test --import tsx/esm "__tests__/schemas/json-schema.test.ts"`
Expected: FAIL on the new test (current shape returns `StandardSchemaWithJSON`, not `{ standard, jsonSchema }`).

- [ ] **Step 6.3: Update `toMcpSchema` to return both pieces**

In [src/schema.ts](src/schema.ts) replace the function with a struct return:

```ts
export interface McpSchemaPair {
  /** Standard Schema instance compatible with @modelcontextprotocol/server. */
  readonly standard: StandardSchemaWithJSON;
  /** Plain JSON Schema object used when registering tool input/output JSON Schemas. */
  readonly jsonSchema: JsonSchema;
}

/**
 * Convert a Zod schema to MCP-compatible Standard Schema + JSON Schema.
 * Removes $schema, cleans up redundant format/pattern combinations,
 * strips defaulted fields from required[], and ensures both input() and output()
 * callables are present on ~standard.jsonSchema.
 */
export function toMcpSchema(
  schema: z.ZodType,
  augment?: (s: JsonSchema) => JsonSchema,
): McpSchemaPair {
  const raw = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override,
  }) as JsonSchema;
  if ('$schema' in raw) delete raw['$schema'];
  const cleaned = removeDefaultedFromRequired(raw) as JsonSchema;
  const final = augment ? augment(cleaned) : cleaned;
  const std = { ...(schema['~standard'] as unknown as Record<string, unknown>) };
  std['jsonSchema'] = { input: () => final, output: () => final };
  const standard = { '~standard': std, jsonSchema: final } as unknown as StandardSchemaWithJSON;
  return { standard, jsonSchema: final };
}
```

- [ ] **Step 6.4: Update callers in `src/tools/define.ts`**

Replace the assignment block (around lines 110-129):

```ts
  const inputSchema = toMcpSchema(def.input, def.inputSchemaAugment);
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
    inputJsonSchema: inputSchema.jsonSchema,
    outputJsonSchema: outputSchema.jsonSchema,

    register(deps: ToolDeps) {
      // ...
```

And the `toolDefShape` (around line 207):

```ts
const toolDefShape = {
  title: def.title,
  description: def.description,
  inputSchema: inputSchema.standard,
  outputSchema: outputSchema.standard,
  annotations: ANNOTATION_HINTS[def.annotations],
};
```

- [ ] **Step 6.5: Search for other `toMcpSchema(...)` callers**

Run: `grep_search` for `toMcpSchema(` across `src/**/*.ts`. Update any other call sites that destructure the old return shape.

Expected callers (based on the audit): only [src/tools/define.ts](src/tools/define.ts). If `grep_search` finds others, update them in this same task.

- [ ] **Step 6.6: Run tests**

Run: `node --test --import tsx/esm "__tests__/schemas/json-schema.test.ts" "__tests__/schemas/snapshot.test.ts" "__tests__/contract.test.ts"`
Expected: PASS. The schema snapshot file should be unchanged (the JSON output is identical, only the wrapper shape changed).

- [ ] **Step 6.7: Run full check**

Run: `node scripts/tasks.mjs`
Expected: full pipeline green (this is the most invasive change — run full test suite, not just `--quick`).

- [ ] **Step 6.8: Commit**

```bash
git add src/schema.ts src/tools/define.ts __tests__/schemas/json-schema.test.ts
git commit -m "refactor(schema): toMcpSchema returns typed { standard, jsonSchema } pair"
```

---

## Task 7: Namespace tracing keys in `_meta` under `io.opentelemetry/`

**Files:**

- Modify: [src/tools/\_helpers.ts](src/tools/_helpers.ts) — `TracingMeta` (around line 49)
- Modify: [src/core/observability.ts](src/core/observability.ts) — `TraceContext` reader (around lines 250-265, 545-557)
- Modify: [src/core/errors.ts](src/core/errors.ts) — `_meta` writer (around lines 29-31, 432-436)
- Test: `__tests__/unit/observability.test.ts` (extend)

**Why:** The MCP spec reserves `_meta` keys without a slash for the protocol's own use; third-party keys SHOULD be namespaced (`namespace/key`). W3C trace-context keys are currently top-level (`traceparent`, `tracestate`, `baggage`). Move them under `io.opentelemetry/`.

This is a **wire-format change**: clients reading `_meta.traceparent` will need to read `_meta['io.opentelemetry/traceparent']` instead. There are no external consumers in this project (the keys only flow out via `_meta` on errors and trace events), so the change is internal.

- [ ] **Step 7.1: Survey current key usage**

Run: `grep_search` (regex) for `traceparent|tracestate|baggage` across `src/**/*.ts` and `__tests__/**/*.ts`. Capture every read site (typically `_meta?.['traceparent']`, `meta.traceparent`, etc.).

Document the call sites (estimated from the audit):

- [src/core/errors.ts](src/core/errors.ts) — `TraceContext` interface and `_meta` build (~lines 29-31, 432-436)
- [src/core/observability.ts](src/core/observability.ts) — `TraceContext` reader (~lines 250-265, 545-557)
- [src/tools/\_helpers.ts](src/tools/_helpers.ts) — `TracingMeta` interface (~line 49)

- [ ] **Step 7.2: Write the failing test**

Create `__tests__/unit/tracing-meta-namespace.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const FILES = [
  '../../src/core/errors.ts',
  '../../src/core/observability.ts',
  '../../src/tools/_helpers.ts',
];

test("trace context keys are namespaced under 'io.opentelemetry/' in _meta builders", async () => {
  for (const rel of FILES) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf8');
    // Disallow bare top-level _meta keys 'traceparent'/'tracestate'/'baggage'
    // when they appear as object literal keys (i.e., string in quotes followed by a colon).
    const bad = [/['"]traceparent['"]\s*:/g, /['"]tracestate['"]\s*:/g, /['"]baggage['"]\s*:/g];
    for (const re of bad) {
      const hits = src.match(re) ?? [];
      assert.equal(
        hits.length,
        0,
        `${rel} still contains bare _meta key matching ${re}; move under 'io.opentelemetry/'`,
      );
    }
    // Positive assertion only on errors.ts (the writer)
    if (rel.endsWith('errors.ts')) {
      assert.match(
        src,
        /['"]io\.opentelemetry\/traceparent['"]/,
        `${rel} should write 'io.opentelemetry/traceparent'`,
      );
    }
  }
});
```

> **Note:** The TypeScript interface field names (e.g. `readonly traceparent?: string;` inside an interface) use identifiers without quotes, so the quoted-only regex above does not flag them. We keep the interface property names as `traceparent`/`tracestate`/`baggage` for ergonomics; only the on-the-wire `_meta` keys move.

- [ ] **Step 7.3: Run test to verify it fails**

Run: `node --test --import tsx/esm "__tests__/unit/tracing-meta-namespace.test.ts"`
Expected: FAIL.

- [ ] **Step 7.4: Update writer in `src/core/errors.ts`**

Around line 432, the existing block is:

```ts
        ...(trace?.traceparent !== undefined ? { traceparent: trace.traceparent } : {}),
        ...(trace?.tracestate !== undefined ? { tracestate: trace.tracestate } : {}),
        ...(trace?.baggage !== undefined ? { baggage: trace.baggage } : {}),
```

Replace with namespaced keys (read the actual surrounding context with `read_file` first to preserve indentation):

```ts
        ...(trace?.traceparent !== undefined
          ? { 'io.opentelemetry/traceparent': trace.traceparent }
          : {}),
        ...(trace?.tracestate !== undefined
          ? { 'io.opentelemetry/tracestate': trace.tracestate }
          : {}),
        ...(trace?.baggage !== undefined
          ? { 'io.opentelemetry/baggage': trace.baggage }
          : {}),
```

- [ ] **Step 7.5: Update reader in `src/core/observability.ts`**

Find the spot (search for `traceparent` around line 540-560) where trace context is **read from incoming `_meta`**. Update reads to fall back on the new key first, then legacy:

```ts
function readTraceparent(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const ns = meta['io.opentelemetry/traceparent'];
  if (typeof ns === 'string') return ns;
  // Legacy fallback for in-flight clients still emitting bare keys.
  const bare = meta['traceparent'];
  return typeof bare === 'string' ? bare : undefined;
}
```

(Repeat for `tracestate` and `baggage`.) Then route the existing reader through these helpers.

If observability.ts currently exposes a `TraceContext` interface with field names `traceparent`/etc., **keep the interface field names** as-is (they're internal); only the wire keys change.

- [ ] **Step 7.6: Update `TracingMeta` shape in `src/tools/_helpers.ts`**

Replace:

```ts
interface TracingMeta {
  traceparent?: string | undefined;
  tracestate?: string | undefined;
  baggage?: string | undefined;
}
```

with:

```ts
/**
 * W3C Trace Context metadata as carried on MCP `_meta`. Wire keys are
 * namespaced under `io.opentelemetry/` per the MCP `_meta` reservation rules;
 * the interface field names below are convenience aliases used in code that
 * reads these values back out via the helper in `src/core/observability.ts`.
 */
interface TracingMeta {
  'io.opentelemetry/traceparent'?: string | undefined;
  'io.opentelemetry/tracestate'?: string | undefined;
  'io.opentelemetry/baggage'?: string | undefined;
}
```

- [ ] **Step 7.7: Run tests**

Run: `node --test --import tsx/esm "__tests__/unit/tracing-meta-namespace.test.ts" "__tests__/unit/observability.test.ts"`
Expected: PASS.

- [ ] **Step 7.8: Run full check**

Run: `node scripts/tasks.mjs`
Expected: full pipeline green.

- [ ] **Step 7.9: Commit**

```bash
git add src/core/errors.ts src/core/observability.ts src/tools/_helpers.ts __tests__/unit/tracing-meta-namespace.test.ts
git commit -m "refactor(meta): namespace W3C trace keys under 'io.opentelemetry/' in _meta"
```

---

## Task 8: Bookmark the future `specTypeSchemas`/`isSpecType`/`RootSchema` migration

**Files:**

- Create: `docs/superpowers/plans/follow-up-mcp-spec-types.md`

**Why:** The audit identified high-value adoptions (`specTypeSchemas`, `isSpecType`, `isCallToolResult`, `RootSchema`, `ListRootsResultSchema`, `JSONObjectSchema`, `JSONValueSchema`) that are not yet exported from `2.0.0-alpha.2`. We don't want this work to drop off the radar when the SDK ships them.

- [ ] **Step 8.1: Create follow-up note**

Create `docs/superpowers/plans/follow-up-mcp-spec-types.md`:

```markdown
# Follow-up: Adopt SDK spec-type schemas & guards

Triggered after `@modelcontextprotocol/server` ships these exports (present at upstream commit `2c0c481` but not in `2.0.0-alpha.2`):

- `specTypeSchemas` — Standard-Schema validators keyed by spec type name
- `isSpecType` — per-type predicates (`isSpecType.Root`, `isSpecType.CallToolResult`, ...)
- `isCallToolResult`
- `RootSchema`, `ListRootsResultSchema`, `ToolSchema`
- `JSONObjectSchema`, `JSONValueSchema`

Verify availability with:
\`\`\`powershell
$dts = Get-Content node_modules/@modelcontextprotocol/server/dist/index.d.mts -Raw
foreach ($p in 'specTypeSchemas','isSpecType','RootSchema','isCallToolResult','JSONObjectSchema') {
if ($dts -match $p) { "FOUND: $p" } else { "MISSING: $p" }
}
\`\`\`

When all are FOUND, schedule:

1. **Replace local `RootSchema`** in `src/server.ts` with the SDK's `RootSchema` and replace `RootsResponseSchema` with the SDK's `ListRootsResultSchema`. Drop the local `isRoot` predicate in favor of `isSpecType.Root`.
2. **Use `isCallToolResult`** in `src/tasks.ts` `executeBackground` to validate handler return shape before storing.
3. **Replace `z.record(z.string(), z.unknown())`** in `src/schema.ts` `Continuation.args` with the SDK's `JSONObjectSchema`.
4. **Delete the `ExperimentalTasksApi` adapter** in `src/tools/define.ts` once `experimental.tasks.registerToolTask` is properly typed.
5. **Drop the legacy bare-key fallback** in `readTraceparent`/`readTracestate`/`readBaggage` once we are confident no in-flight clients emit the old shape.
```

- [ ] **Step 8.2: Commit**

```bash
git add docs/superpowers/plans/follow-up-mcp-spec-types.md
git commit -m "docs: bookmark follow-up MCP spec-type adoption plan"
```

---

## Final verification

- [ ] **Step F.1: Run the full test + build pipeline**

Run: `node scripts/tasks.mjs`
Expected: format → lint → type-check → knip → test → build all pass.

- [ ] **Step F.2: Walk the audit checklist**

Confirm each gap from the audit either landed (1, 5) or is bookmarked (8):

- [x] Gap 1 — `RootSchema` `file://` rule: Task 3 (local enforcement) + Task 8 (SDK-import follow-up).
- [x] Gap 2 — type guards: `parseJSONRPCMessage` adopted in Task 2; `isCallToolResult` bookmarked in Task 8.
- [x] Gap 3 — `specTypeSchemas`/`isSpecType`: Task 8 bookmark.
- [x] Gap 4 — `toMcpSchema` lean / cast removal: Task 6.
- [x] Gap 5 — `as unknown as` escape hatches: Tasks 4, 5, 6.
- [x] Gap 6 — `JSONRPC_VERSION` literal: Task 1.
- [x] Gap 7 — `JSONValue` re-impl: Task 8 bookmark.
- [x] Gap 8 — `_meta` namespacing: Task 7.

- [ ] **Step F.3: Push branch and open PR**

(Defer to user — this is a write that affects shared state.)

---

## Self-Review notes

**Spec coverage:** every audit gap maps to a task or bookmark above (see Final verification matrix).

**Placeholder scan:** no TODO/TBD strings, every code step shows the actual code, every test step shows full assertions and the expected pass/fail outcome.

**Type consistency:**

- `coreHandler` is annotated `Promise<CallToolResult>` in Task 4; `serverCtxHandler` returns the same in Task 4.
- `toMcpSchema`'s new return type `McpSchemaPair { standard, jsonSchema }` is referenced consistently in Task 6 (creation), Task 6 step 6.4 (callers), and the test in step 6.1.
- `ExperimentalTasksApi` is used only via `getExperimentalTasks(server)` introduced in Task 5.
- `TracingMeta` keys `io.opentelemetry/traceparent` etc. match the writer in Task 7 step 7.4 and the reader helper signature in step 7.5.
