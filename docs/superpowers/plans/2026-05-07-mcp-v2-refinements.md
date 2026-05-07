# MCP v2 Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `server.server.getCapabilities()` anti-pattern, then migrate the HTTP layer from hand-rolled `node:http` to `createMcpExpressApp()`.

**Architecture:** Thread `hasTaskSupport: boolean` through `ToolRegistrationOptions` so capability detection uses startup-time state instead of the deprecated low-level API. Rewrite `startHttpServer` in `src/server/bootstrap.ts` to use an Express app produced by `createMcpExpressApp()`, delegating CORS/origin/host validation to the SDK while keeping custom session management, stale sweep, Bearer auth, and the InMemoryEventStore.

**Tech Stack:** `@modelcontextprotocol/express ^2.0.0-alpha.2`, `express ^5`, `@types/express ^5` (dev). Node.js 24, ESM, TypeScript strict.

---

## File Map

| File | What changes |
|---|---|
| `src/tools/shared.ts` | Add `hasTaskSupport?: boolean` to `ToolRegistrationOptions` |
| `src/tools/task-support.ts` | Delete `hasTaskToolCapability`; remove capability check from `tryRegisterToolTask`; update `registerToolTaskIfAvailable` signature (iconInfo+guard → options) |
| `src/server/bootstrap.ts` | Derive `hasTaskSupport` from built capabilities; pass in `registerAllTools`; rewrite `startHttpServer` with Express; delete ~10 functions |
| `package.json` | Add runtime + dev dependencies |
| `__tests__/http.test.ts` | Possibly update 403 error-message assertions; add/adjust 405 assertion if needed |
| `__tests__/contract.test.ts` | No changes expected — task flags already set, test already correct |

---

## Task 1: Confirm baseline

**Files:** (read-only)

- [ ] **Step 1: Run the full test suite to confirm a clean baseline**

```powershell
cd c:/filesystem-mcp && node scripts/tasks.mjs
```

Expected: all checks pass (format, lint, type-check, knip, tests, rebuild). If anything fails, fix it before continuing — do not mix baseline failures with migration failures.

---

## Task 2: Add `hasTaskSupport` to `ToolRegistrationOptions`

**Files:**
- Modify: `src/tools/shared.ts` (around line 488)

- [ ] **Step 1: Add the field**

In `src/tools/shared.ts`, locate `ToolRegistrationOptions` (currently at line 488):

```ts
// BEFORE
export interface ToolRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
}

// AFTER
export interface ToolRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  hasTaskSupport?: boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
}
```

- [ ] **Step 2: Type-check only — no behaviour change yet**

```powershell
npm run type-check
```

Expected: passes.

---

## Task 3: Refactor `task-support.ts` — remove `server.server` access

**Files:**
- Modify: `src/tools/task-support.ts`

- [ ] **Step 1: Delete `hasTaskToolCapability` and update `tryRegisterToolTask`**

Locate `hasTaskToolCapability` (line 98) and `tryRegisterToolTask` (line 535). Make these changes:

**Delete the entire `hasTaskToolCapability` function** (lines 98–105):
```ts
// DELETE THIS:
function hasTaskToolCapability(server: McpServer): boolean {
  try {
    const capabilities = server.server.getCapabilities();
    return capabilities.tasks?.requests?.tools?.call !== undefined;
  } catch {
    return false;
  }
}
```

**Remove the capability guard from `tryRegisterToolTask`** — delete only the first line of the function body:
```ts
// BEFORE (line 542):
if (!hasTaskToolCapability(server)) return false;

// AFTER: delete that line entirely — the check moves to registerToolTaskIfAvailable
```

`tryRegisterToolTask` after the change:
```ts
function tryRegisterToolTask<Args extends ToolSchema>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  taskHandler: ToolTaskHandler<Args>,
  iconInfo: IconInfo | undefined
): boolean {
  const def = toolDef as Record<string, unknown>;
  const existingExecution =
    (def.execution as Record<string, unknown> | undefined) ?? {};
  const taskSupport = resolveToolTaskSupportLevel(
    def.taskSupport,
    existingExecution.taskSupport
  );

  if (!taskSupport || taskSupport === 'forbidden') return false;

  server.experimental.tasks.registerToolTask(
    toolName,
    withDefaultIcons(
      { ...toolDef, execution: { ...existingExecution, taskSupport } },
      iconInfo
    ) as never,
    taskHandler as never
  );
  return true;
}
```

- [ ] **Step 2: Update `registerToolTaskIfAvailable` signature — replace `iconInfo + guard` with `options`**

Current signature (line 565):
```ts
function registerToolTaskIfAvailable<Args extends ToolSchema, Result>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<Result>>,
  iconInfo: IconInfo | undefined,
  guard?: () => boolean
): boolean {
  const taskOptions = {
    ...(guard ? { guard } : {}),
    toolName,
  };
  return tryRegisterToolTask(
    server,
    toolName,
    toolDef,
    createToolTaskHandler(run as never, taskOptions) as ToolTaskHandler<Args>,
    iconInfo
  );
}
```

Replace with:
```ts
function registerToolTaskIfAvailable<Args extends ToolSchema, Result>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  run: (
    args: ToolArgs<Args>,
    ctx: TaskToolContext
  ) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions
): boolean {
  if (!options.hasTaskSupport) return false;
  const taskOptions = {
    ...(options.isInitialized ? { guard: options.isInitialized } : {}),
    toolName,
  };
  return tryRegisterToolTask(
    server,
    toolName,
    toolDef,
    createToolTaskHandler(run as never, taskOptions) as ToolTaskHandler<Args>,
    options.iconInfo
  );
}
```

- [ ] **Step 3: Update the call site in `registerStandardTool`**

Locate the call to `registerToolTaskIfAvailable` inside `registerStandardTool` (around line 616):

```ts
// BEFORE
if (
  registerToolTaskIfAvailable(
    server,
    toolDef.name,
    toolDef,
    validatedHandler,
    options.iconInfo,
    options.isInitialized
  )
) {
  return;
}

// AFTER
if (
  registerToolTaskIfAvailable(
    server,
    toolDef.name,
    toolDef,
    validatedHandler,
    options
  )
) {
  return;
}
```

- [ ] **Step 4: Type-check**

```powershell
npm run type-check
```

Expected: passes. If `ToolRegistrationOptions` import is missing from task-support.ts, add it:
```ts
import type { ..., ToolRegistrationOptions } from './shared.js';
```

---

## Task 4: Thread `hasTaskSupport` from `bootstrap.ts`

**Files:**
- Modify: `src/server/bootstrap.ts` (inside `createServer`)

- [ ] **Step 1: Derive `hasTaskSupport` after building capabilities and pass it to `registerAllTools`**

Locate the block in `createServer()` where `registerAllTools` is called (around line 243). The capabilities are built at line 179. Make the following change:

```ts
// After this existing line:
const capabilities = buildServerCapabilities({
  enablePromptListChanged: false,
  enableTaskToolRequests: true,
});

// Add this derivation:
const hasTaskSupport =
  capabilities.tasks?.requests?.tools?.call !== undefined;
```

Then update the `registerAllTools` call (around line 243):

```ts
// BEFORE
registerAllTools(server, {
  pathGuard: rootsManager.pathGuard,
  resourceStore,
  isInitialized: () => rootsManager.isInitialized(),
  ...(localIcon ? { iconInfo: localIcon } : {}),
});

// AFTER
registerAllTools(server, {
  pathGuard: rootsManager.pathGuard,
  resourceStore,
  isInitialized: () => rootsManager.isInitialized(),
  hasTaskSupport,
  ...(localIcon ? { iconInfo: localIcon } : {}),
});
```

- [ ] **Step 2: Type-check and run tests**

```powershell
npm run type-check && node --test --import tsx/esm "__tests__/**/*.test.ts"
```

Expected: all tests pass. The behaviour is unchanged — task registration still happens for the same tools. Only the mechanism for capability detection changed (startup state instead of runtime `server.server` call).

- [ ] **Step 3: Commit**

```powershell
git add src/tools/shared.ts src/tools/task-support.ts src/server/bootstrap.ts
git commit -m "refactor: thread hasTaskSupport flag — remove server.server.getCapabilities() access"
```

---

## Task 5: Verify task support flags (no code changes)

**Files:** (read-only check)

The five bulk tools (`grep`, `find`, `tree`, `stat_many`, `read_many`) already have `taskSupport: 'optional'` set in their contracts, and the contract test already expects them in `TASK_OPTIONAL_TOOLS`. Confirm this is working correctly after Task 4.

- [ ] **Step 1: Run contract test only**

```powershell
node --test --import tsx/esm __tests__/contract.test.ts
```

Expected: passes, including `'task-capable tools expose execution.taskSupport in tools/list'`. If it fails, check that `hasTaskSupport: true` is correctly threaded through to the tool registration calls. The tools with `taskSupport: 'optional'` that must show `execution.taskSupport: 'optional'` in `tools/list` are: `apply_patch`, `calculate_hash`, `diff_files`, `grep`, `find`, `ls`, `read_many`, `search_and_replace`, `stat_many`, `tree`.

---

## Task 6: Install Express dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependencies**

```powershell
npm install @modelcontextprotocol/express@^2.0.0-alpha.2 express@^5
```

- [ ] **Step 2: Install dev dependency**

```powershell
npm install --save-dev @types/express@^5
```

- [ ] **Step 3: Verify imports resolve**

```powershell
node -e "import('@modelcontextprotocol/express').then(m => console.log('ok:', Object.keys(m)))"
```

Expected: prints `ok:` with exported names including `createMcpExpressApp`.

---

## Task 7: Rewrite `startHttpServer` with Express

**Files:**
- Modify: `src/server/bootstrap.ts`

This is the largest single change. Do it in two sub-steps: first add the new implementation alongside the old one, then delete the old functions.

- [ ] **Step 1: Add new imports at the top of `bootstrap.ts`**

Add after the existing `@modelcontextprotocol/*` imports:

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
```

Remove the import of `LOCALHOST_ORIGIN_RE` usage sites won't be needed after deletion, but keep it until the functions are deleted in Step 3.

- [ ] **Step 2: Replace the body of `startHttpServer` with the Express version**

The full new function body (replace everything from `const sessions = new Map` to the closing `}`):

```ts
export async function startHttpServer(
  port: number,
  options: ServerOptions
): Promise<Server> {
  const sessions = new Map<string, HttpSession>();
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env.FILESYSTEM_MCP_HTTP_HOST ?? '127.0.0.1';
  assertHttpBindingSecurity(httpHost);

  const app = createMcpExpressApp({
    host: httpHost,
    allowedHosts: isLoopbackHttpHost(httpHost)
      ? localhostAllowedHostnames()
      : [httpHost],
  });

  // Bearer auth — runs before all /mcp requests
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (!ensureAuthorizedRequest(req as never, res as never)) return;
    next();
  });

  // Body parsing with size cap
  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES, strict: false }));

  // Body-parse error → JSON-RPC format
  app.use(
    (
      err: Error & { status?: number },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (err.status === 413) {
        sendJsonRpcError(
          res as never,
          413,
          JSON_RPC_INVALID_REQUEST,
          'Request body too large'
        );
        return;
      }
      if (err.status === 400) {
        sendJsonRpcError(
          res as never,
          400,
          JSON_RPC_PARSE_ERROR,
          'Invalid JSON in request body'
        );
        return;
      }
      next(err);
    }
  );

  app.all('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = getSessionId(req as never);

      if (req.method === 'POST') {
        if (sessionId) {
          const session = getSessionOrRespondNotFound(
            sessions,
            sessionId,
            res as never
          );
          if (session) {
            await handleSessionTransportRequest(
              session,
              req as never,
              res as never,
              req.body as unknown
            );
          }
          return;
        }

        if (isInitializeRequest(req.body as unknown)) {
          const maxSessions = parseEnvInt(
            'FILESYSTEM_MCP_MAX_HTTP_SESSIONS',
            100,
            1,
            10_000
          );
          if (sessions.size >= maxSessions) {
            sendJsonRpcError(
              res as never,
              503,
              JSON_RPC_SERVER_ERROR,
              'Too many sessions'
            );
            return;
          }
          const session = await createHttpSession(
            options,
            sessions,
            eventStore
          );
          await handleSessionTransportRequest(
            session,
            req as never,
            res as never,
            req.body as unknown
          );
          return;
        }

        sendJsonRpcError(
          res as never,
          400,
          JSON_RPC_SERVER_ERROR,
          'Bad Request: No valid session ID provided'
        );
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId) {
          sendJsonRpcError(
            res as never,
            400,
            JSON_RPC_SERVER_ERROR,
            'Bad Request: Missing session ID'
          );
          return;
        }
        const session = getSessionOrRespondNotFound(
          sessions,
          sessionId,
          res as never
        );
        if (session) {
          await handleSessionTransportRequest(session, req as never, res as never);
        }
        return;
      }

      // Unsupported method
      res
        .status(405)
        .set('Allow', 'GET, POST, DELETE, OPTIONS')
        .json({
          jsonrpc: '2.0',
          error: { code: JSON_RPC_SERVER_ERROR, message: 'Method Not Allowed' },
          id: null,
        });
    } catch (error) {
      Logger.error(
        '[HTTP] Error handling request:',
        formatUnknownErrorMessage(error)
      );
      if (!res.headersSent) {
        sendJsonRpcError(
          res as never,
          500,
          JSON_RPC_INTERNAL_ERROR,
          'Internal Server Error'
        );
      }
    }
  });

  const initHandshakeTimeoutMs = getInitHandshakeTimeoutMs();
  const SWEEP_INTERVAL_MS = initHandshakeTimeoutMs * 2;

  const httpServer = createHttpServer(app as never);
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (
        !session.rootsManager.isInitialized() &&
        now - session.createdAt > initHandshakeTimeoutMs
      ) {
        Logger.warn(
          `[HTTP] Evicting stale session ${sessionId}: client never sent notifications/initialized`
        );
        session.close().catch((err: unknown) => {
          Logger.error(
            `[HTTP] Error closing stale session ${sessionId}:`,
            formatUnknownErrorMessage(err)
          );
          eventStore.delete(sessionId);
        });
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  let closingSessions: Promise<void> | undefined;

  async function closeAllSessions(): Promise<void> {
    if (closingSessions) return closingSessions;
    closingSessions = (async () => {
      const activeSessions = [...sessions.values()];
      sessions.clear();
      eventStore.clear();
      await Promise.allSettled(
        activeSessions.map((session) => session.close())
      );
    })();
    await closingSessions;
  }

  httpServer.once('close', () => {
    clearInterval(sweepTimer);
  });

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = (callback?: (error?: Error) => void) => {
    void closeAllSessions().catch((error: unknown) => {
      Logger.error(
        '[HTTP] Error closing sessions before server shutdown:',
        formatUnknownErrorMessage(error)
      );
    });
    return originalClose(callback);
  };

  return new Promise<Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, httpHost, () => {
      Logger.info(`MCP HTTP server listening on ${httpHost}:${port}`);
      httpServer.on('error', (err: Error) => {
        Logger.error('[HTTP] Server runtime error:', err.message);
      });
      resolve(httpServer);
    });
  });
}
```

Note on type casts: `req as never` and `res as never` are used because helper functions typed against `IncomingMessage`/`ServerResponse` are called with Express's `Request`/`Response`. At runtime these are compatible (Express types extend Node.js types). If TypeScript strict mode makes these casts difficult, import `IncomingMessage` and `ServerResponse` from `node:http` and use `req as unknown as IncomingMessage` etc. instead.

- [ ] **Step 3: Type-check**

```powershell
npm run type-check
```

Fix any type errors before proceeding. Common issues:
- Missing imports for `createMcpExpressApp`, `express`, Express types
- `createHttpServer` needs `app as never` if types don't align — use the cast shown above
- `sendJsonRpcError` expects `ServerResponse` — use `res as never` or cast explicitly

---

## Task 8: Delete the removed functions from `bootstrap.ts`

**Files:**
- Modify: `src/server/bootstrap.ts`

- [ ] **Step 1: Delete the following functions and constants** (they are now dead code):

- `LOCALHOST_ORIGIN_RE` constant
- `EXPOSED_HEADERS` constant
- `setCorsHeaders` function
- `normalizeAllowedHostname` function
- `getAllowedHostnames` function
- `isAllowedOrigin` function
- `ensureAllowedOrigin` function
- `ensureAllowedHostHeader` function
- `writeMethodNotAllowedResponse` function
- `RequestBodyError` class
- `readRequestBody` function
- `handleHttpRequestError` function
- `dispatchMcpMethod` function
- `handlePostRequest` function (the inner function inside old `startHttpServer`)
- `handleGetDeleteRequest` function (same)
- `discardRequestBody` function
- `MAX_SESSION_ID_LENGTH` constant — check if still used; if only used by `getSessionId`, keep it

Also check `MAX_BEARER_TOKEN_LENGTH` — it's used by `isAuthorizedBearer`, keep it.

- [ ] **Step 2: Run lint to find any remaining references**

```powershell
npm run lint
```

If lint reports unused variables or imports, remove them. Common leftover: `LOCALHOST_ORIGIN_RE`, `IncomingMessage` import (still needed for types in remaining functions), `ServerResponse` import (same).

Check which `node:http` imports are still needed:
- `createServer as createHttpServer` — still needed ✓
- `type IncomingMessage` — still needed by `getSessionId`, `handleSessionTransportRequest`, `sendJsonRpcError`, etc. ✓
- `type Server` — still needed for return type ✓
- `type ServerResponse` — still needed ✓

- [ ] **Step 3: Type-check and run lint clean**

```powershell
npm run type-check && npm run lint
```

Expected: both pass with 0 errors/warnings.

---

## Task 9: Run HTTP tests and fix any failures

**Files:**
- Modify: `__tests__/http.test.ts` (only if assertions need updating)

- [ ] **Step 1: Run only the HTTP tests**

```powershell
node --test --import tsx/esm __tests__/http.test.ts
```

Expected: most tests pass. The tests most likely to need attention:

**403 origin rejection** (`'rejects browser origins outside localhost'`):
- Current assertion: `assert.match(await response.text(), /Forbidden: disallowed origin/u)`
- `createMcpExpressApp()` handles this internally. If the response body does not contain the phrase `Forbidden: disallowed origin`, update the assertion to match whatever the SDK sends. Run the test, read the actual response body in the failure output, then update:
  ```ts
  // Example update if SDK sends a different message:
  assert.equal(response.status, 403);
  // Replace regex with whatever the SDK actually sends, e.g.:
  assert.match(await response.text(), /forbidden/iu);
  ```

**403 Host header rejection** (`'rejects loopback requests with a disallowed Host header'`):
- Current assertion: `assert.match(response.body, /Forbidden: Invalid Host/u)`
- Same approach: run test, read actual response, update regex if needed.

**405 unsupported method** (`'returns 405 for unsupported HTTP methods on /mcp'`):
- Should pass as-is — the route handler explicitly returns 405 with the correct `Allow` header and JSON-RPC body.
- If it fails, verify that the `app.all('/mcp', ...)` handler reaches the unsupported-method branch for PUT.

**413 oversized body** (`'returns 413 for request bodies exceeding the size limit'`):
- Should pass — Express body-parser 413 → our error middleware → `'Request body too large'` matches `/too large/iu`. ✓

- [ ] **Step 2: Commit once HTTP tests pass**

```powershell
git add src/server/bootstrap.ts package.json package-lock.json __tests__/http.test.ts
git commit -m "feat: migrate HTTP layer to createMcpExpressApp() — remove hand-rolled CORS/origin/auth middleware"
```

---

## Task 10: Full suite and final commit

- [ ] **Step 1: Run the full task pipeline**

```powershell
node scripts/tasks.mjs
```

Expected: format → lint → type-check → knip → tests → rebuild, all green. If knip reports unused exports from the deleted functions, remove them from `bootstrap.ts`. If any test fails, fix it before committing.

- [ ] **Step 2: Final commit if anything was adjusted**

If Step 1 required any fixes:

```powershell
git add -p  # stage only the fixup changes
git commit -m "fix: address post-migration lint/test issues"
```

---

## Quick Reference — Functions deleted vs kept

| Deleted | Kept |
|---|---|
| `setCorsHeaders` | `assertHttpBindingSecurity` |
| `isAllowedOrigin` | `isLoopbackHttpHost` |
| `ensureAllowedOrigin` | `isAuthorizedBearer` |
| `ensureAllowedHostHeader` | `ensureAuthorizedRequest` |
| `normalizeAllowedHostname` | `writeUnauthorizedResponse` |
| `getAllowedHostnames` | `getSessionId` |
| `writeMethodNotAllowedResponse` | `sendJsonRpcError` |
| `dispatchMcpMethod` | `createHttpSession` |
| `handlePostRequest` | `handleSessionTransportRequest` |
| `handleGetDeleteRequest` | `getSessionOrRespondNotFound` |
| `RequestBodyError` | session `Map` + stale sweep |
| `readRequestBody` | `InMemoryEventStore` usage |
| `handleHttpRequestError` | `closeAllSessions` |
| `discardRequestBody` | `httpServer` timeouts + close override |
| `LOCALHOST_ORIGIN_RE` | `MAX_BEARER_TOKEN_LENGTH` |
| `EXPOSED_HEADERS` | `MAX_SESSION_ID_LENGTH` |
| `hasTaskToolCapability` | — |
