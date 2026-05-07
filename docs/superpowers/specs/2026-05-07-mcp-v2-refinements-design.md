# MCP v2 Refinements Design

**Date:** 2026-05-07
**Branch:** dev
**Status:** Approved — ready for implementation

## Overview

Three targeted improvements to align the server more tightly with MCP v2 SDK conventions:

1. **HTTP layer** — replace ~120 lines of hand-rolled security middleware with `createMcpExpressApp()` from `@modelcontextprotocol/express`
2. **`server.server` removal** — eliminate the `server.server.getCapabilities()` anti-pattern by threading a `hasTaskSupport` boolean through `ToolRegistrationOptions`
3. **Task support flags** — enable `taskSupport: 'optional'` on five slow bulk tools that already have the task infrastructure available

Breaking changes are intentional; no fallbacks or legacy paths are added.

---

## Section 1: HTTP Migration to `createMcpExpressApp()`

### Motivation

`src/server/bootstrap.ts` currently hand-rolls ~120 lines of HTTP security logic (CORS headers, origin validation, DNS rebinding protection, method dispatch, body parsing with size limits) using `node:http` directly. The MCP v2 SDK ships `createMcpExpressApp()` in `@modelcontextprotocol/express` that covers all of this. Moving to it reduces maintenance surface and keeps the security model aligned with SDK guarantees as the alpha evolves.

### New dependencies

Add to `package.json` as **runtime** dependencies (needed in the distributed binary):

```json
"@modelcontextprotocol/express": "^2.0.0-alpha.2",
"express": "^5"
```

Add to `devDependencies`:

```json
"@types/express": "^5"
```

### Deletions from `bootstrap.ts`

The following functions are removed entirely:

| Function                                           | Replaced by                             |
| -------------------------------------------------- | --------------------------------------- |
| `setCorsHeaders`                                   | `createMcpExpressApp()` internals       |
| `isAllowedOrigin` / `ensureAllowedOrigin`          | `createMcpExpressApp({ allowedHosts })` |
| `ensureAllowedHostHeader`                          | same                                    |
| `normalizeAllowedHostname` / `getAllowedHostnames` | same                                    |
| `writeMethodNotAllowedResponse`                    | Express handles 405                     |
| `dispatchMcpMethod`                                | Express route per method                |
| `handlePostRequest` / `handleGetDeleteRequest`     | inlined in `app.all('/mcp', ...)`       |
| `RequestBodyError` class                           | Express body-parser error shape         |
| `readRequestBody`                                  | `express.json({ limit })` middleware    |
| `handleHttpRequestError`                           | Express error middleware                |

### What stays

These have no SDK equivalent and remain unchanged:

- `assertHttpBindingSecurity` — startup guard for non-loopback binds without API key
- `isLoopbackHttpHost` — used in `assertHttpBindingSecurity` and `allowedHosts` derivation
- `isAuthorizedBearer` / `ensureAuthorizedRequest` / `writeUnauthorizedResponse` — Bearer auth logic
- `getSessionId` — reads `mcp-session-id` header
- `sendJsonRpcError` — JSON-RPC error response helper
- `createHttpSession` — per-session McpServer + RootsManager lifecycle
- `handleSessionTransportRequest` — wraps transport call with `SessionContext.run` + `withPathGuard`
- `getSessionOrRespondNotFound` — session lookup helper
- Session `Map`, stale-session sweep interval — multi-session state management
- `InMemoryEventStore` — SSE resumability store

### New `startHttpServer` structure

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

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

  // Bearer auth middleware — runs before all /mcp requests
  app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
    if (!ensureAuthorizedRequest(req, res)) return;
    next();
  });

  // Body parsing with size cap
  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES, strict: false }));

  // Body-parse error handler — translate to JSON-RPC error format
  app.use(
    (
      err: Error & { status?: number },
      _req: Request,
      res: Response,
      next: NextFunction
    ) => {
      if (err.status === 413) {
        sendJsonRpcError(
          res,
          413,
          JSON_RPC_INVALID_REQUEST,
          'Request body too large'
        );
        return;
      }
      if (err.status === 400) {
        sendJsonRpcError(
          res,
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
      const sessionId = getSessionId(req);

      if (req.method === 'POST') {
        if (sessionId) {
          const session = getSessionOrRespondNotFound(sessions, sessionId, res);
          if (session)
            await handleSessionTransportRequest(session, req, res, req.body);
          return;
        }
        if (isInitializeRequest(req.body)) {
          const maxSessions = parseEnvInt(
            'FILESYSTEM_MCP_MAX_HTTP_SESSIONS',
            100,
            1,
            10_000
          );
          if (sessions.size >= maxSessions) {
            sendJsonRpcError(
              res,
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
          await handleSessionTransportRequest(session, req, res, req.body);
          return;
        }
        sendJsonRpcError(
          res,
          400,
          JSON_RPC_SERVER_ERROR,
          'Bad Request: No valid session ID provided'
        );
        return;
      }

      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId) {
          sendJsonRpcError(
            res,
            400,
            JSON_RPC_SERVER_ERROR,
            'Bad Request: Missing session ID'
          );
          return;
        }
        const session = getSessionOrRespondNotFound(sessions, sessionId, res);
        if (session) await handleSessionTransportRequest(session, req, res);
        return;
      }
    } catch (error) {
      Logger.error(
        '[HTTP] Error handling request:',
        formatUnknownErrorMessage(error)
      );
      if (!res.headersSent) {
        sendJsonRpcError(
          res,
          500,
          JSON_RPC_INTERNAL_ERROR,
          'Internal Server Error'
        );
      }
    }
  });

  const httpServer = createHttpServer(app);
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  // Stale session sweep — unchanged
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (
        !session.rootsManager.isInitialized() &&
        now - session.createdAt > initHandshakeTimeoutMs
      ) {
        Logger.warn(`[HTTP] Evicting stale session ${sessionId}`);
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

  // ... httpServer.once('close', ...), httpServer.close override, listen
}
```

Express's `Request` extends `IncomingMessage` and `Response` extends `ServerResponse`, so `handleSessionTransportRequest` and `sendJsonRpcError` are type-compatible without signature changes.

### Net delta

~120 lines deleted, ~60 lines added in `bootstrap.ts`. Two new runtime dependencies.

---

## Section 2: Remove `server.server.getCapabilities()`

### Motivation

`server.server.getCapabilities()` in `src/tools/task-support.ts:99` accesses the deprecated low-level `Server` class that `McpServer` wraps. The fix threads the information already known at startup through `ToolRegistrationOptions` instead.

### What changes

**`src/tools/shared.ts`** — add field to `ToolRegistrationOptions`:

```ts
export interface ToolRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  hasTaskSupport?: boolean; // ← new: true when tasks capability is enabled
  serverIcon?: string;
  iconInfo?: IconInfo;
}
```

**`src/tools/task-support.ts`** — delete `hasTaskToolCapability`, update `registerToolTaskIfAvailable`:

Current signature: `(server, toolName, toolDef, run, iconInfo: IconInfo | undefined, guard?: () => boolean)`.

The `iconInfo` and `guard` params are replaced by passing `options: ToolRegistrationOptions` directly — `options` already carries both (`options.iconInfo`, `options.isInitialized`). The call site in `registerStandardTool` stops passing them separately and passes `options` as a whole.

```ts
// Delete this entire function:
// function hasTaskToolCapability(server: McpServer): boolean { ... }

// Updated signature — options replaces iconInfo + guard:
function registerToolTaskIfAvailable<Args extends ToolSchema, Result>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  run: (...) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions,
): boolean {
  if (!options.hasTaskSupport) return false;   // ← replaces hasTaskToolCapability(server)
  return tryRegisterToolTask(server, toolName, toolDef, ..., options.iconInfo);
}

// Updated call site in registerStandardTool:
if (registerToolTaskIfAvailable(server, toolDef.name, toolDef, validatedHandler, options)) {
  return;
}
```

**`src/server/bootstrap.ts`** — derive `hasTaskSupport` from built capabilities and pass it:

```ts
const capabilities = buildServerCapabilities({ enableTaskToolRequests: true });
const hasTaskSupport = capabilities.tasks?.requests?.tools?.call !== undefined;

registerAllTools(server, {
  pathGuard: rootsManager.pathGuard,
  resourceStore,
  isInitialized: () => rootsManager.isInitialized(),
  hasTaskSupport,
  ...(localIcon ? { iconInfo: localIcon } : {}),
});
```

### What stays

`server.server.setRequestHandler('logging/setLevel', ...)` in `bootstrap.ts:223` is kept. There is no `McpServer` API for intercepting `logging/setLevel` in alpha.2 — it is raw JSON-RPC that `McpServer` does not expose. This is the explicit exception case in the v2 skill: _"only reach for `Server` when you must intercept raw JSON-RPC that `McpServer` doesn't expose."_

---

## Section 3: Task Support Flags on Slow Bulk Tools

### Motivation

The task infrastructure is fully built and working. Five tools run operations that can take seconds on real filesystems (deep trees, large directories, many paths, large file sets) but are currently excluded from task-mode. Enabling `taskSupport: 'optional'` on them gives clients long-running-operation support at zero handler cost — `registerStandardTool` already routes to `server.experimental.tasks.registerToolTask` when the flag is present and `hasTaskSupport` is true.

### Changes

One line per tool contract (`taskSupport: 'optional'` added):

| Tool             | File                          | Operation                                 |
| ---------------- | ----------------------------- | ----------------------------------------- |
| `search-content` | `src/tools/search-content.ts` | grep — seconds on large dirs              |
| `search-files`   | `src/tools/search-files.ts`   | glob traversal — unbounded on deep trees  |
| `tree`           | `src/tools/tree.ts`           | recursive stat walk                       |
| `stat-many`      | `src/tools/stat-many.ts`      | batch stat, linear in path count          |
| `read-many`      | `src/tools/read-multiple.ts`  | batch reads, linear in file count + sizes |

Example diff:

```ts
export const SEARCH_CONTENT_TOOL: ToolContract = {
  name: 'search-content',
  // ... existing fields unchanged ...
  taskSupport: 'optional', // ← add
} as const;
```

### Exclusions

Write tools (`apply-patch`, `edit-file`, `write-file`, `replace-in-files`, `delete-file`, `move-file`) are excluded — task-mode for destructive writes introduces idempotency questions and the operations complete fast enough. `read` stays `'forbidden'` — single-file reads are instantaneous.

### No handler changes needed

`resolveToolTaskSupportLevel` in `shared.ts` reads `taskSupport` from the contract. `registerStandardTool` already calls `registerToolTaskIfAvailable` and falls back to `server.registerTool` when task support is off or unavailable. The handler code in each tool file is untouched.

---

## File Change Summary

| File                          | Change                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `package.json`                | Add `@modelcontextprotocol/express`, `express` (runtime); `@types/express` (dev) |
| `src/server/bootstrap.ts`     | HTTP migration + `hasTaskSupport` derivation and pass-through                    |
| `src/tools/shared.ts`         | Add `hasTaskSupport?: boolean` to `ToolRegistrationOptions`                      |
| `src/tools/task-support.ts`   | Delete `hasTaskToolCapability`; check `options.hasTaskSupport`                   |
| `src/tools/search-content.ts` | `taskSupport: 'optional'`                                                        |
| `src/tools/search-files.ts`   | `taskSupport: 'optional'`                                                        |
| `src/tools/tree.ts`           | `taskSupport: 'optional'`                                                        |
| `src/tools/stat-many.ts`      | `taskSupport: 'optional'`                                                        |
| `src/tools/read-multiple.ts`  | `taskSupport: 'optional'`                                                        |
| `__tests__/http.test.ts`      | Update to match Express-based HTTP surface                                       |
| `__tests__/contract.test.ts`  | Update expected `taskSupport` values for 5 tools                                 |

---

## Implementation Order

1. **Section 2 first** (`hasTaskSupport` flag) — it's the smallest and has no new dependencies; establishes the `ToolRegistrationOptions` shape that Section 1 also touches.
2. **Section 3** (`taskSupport: 'optional'` flags) — independent of 1 and 2, can be done in same pass as 2.
3. **Section 1 last** (HTTP migration) — largest change, isolated to `bootstrap.ts` and tests; benefits from Sections 2/3 being already committed.

---

## Verification

After all sections: `node scripts/tasks.mjs` must pass clean — format, lint, type-check, knip, tests, rebuild.
