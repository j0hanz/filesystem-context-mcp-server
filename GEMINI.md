# AGENTS.md

This file provides guidance to agents using the Filesystem MCP server. It covers how to connect, available tools, and best practices for safe and effective interactions.

## Commands

The dev loop is driven by `scripts/tasks.mjs` (alias: `npm run tasks`).

```bash
node scripts/tasks.mjs check          # format → [lint, type-check, knip] → [test, rebuild]
node scripts/tasks.mjs check --quick  # static checks only (skip test + rebuild)
node scripts/tasks.mjs fix            # auto-fix format/lint/knip, then re-validate
node scripts/tasks.mjs test           # run tests directly
node scripts/tasks.mjs test --watch   # watch mode
node scripts/tasks.mjs detail <n>     # show source window for the Nth test failure
```

Useful test flags: `--name-pattern <regex>`, `--timeout <ms>`, `--shard <i/n>`, `--update-snapshots`.

After a failure, `--llm` appends a structured JSON block to stdout and writes `.tasks-last-failure.json`.

**Run a single test file:**

```bash
node --test --import tsx/esm "__tests__/unit/path-guard.test.ts"
```

## Architecture

### Request flow

```text
src/index.ts  →  src/cli.ts (parseArgs)
             →  src/transport.ts (startServer | startHttpServer)
             →  src/server.ts (createServer → FilesystemServerContext)
```

`FilesystemServerContext` is the root object holding:

- `mcp: McpServer` — the MCP SDK server instance
- `roots: RootsManager` — tracks allowed directories, handles MCP Roots protocol
- `resources: ResourceStore` — in-memory temporary resource store (TTL-based)
- `resourcesHandle: ResourcesHandle` — manages resource list-changed notifications

### Transports

Two transport modes, selected by whether `--port` is passed:

- **stdio** (`startServer`): single-session, `StdioServerTransport`
- **HTTP** (`startHttpServer`): multi-session, Express + `NodeStreamableHTTPServerTransport` on `/mcp`. Each POST with no `mcp-session-id` that carries an `initialize` request spawns a new `FilesystemServerContext`. `HttpSessionRegistry` owns the session map and sweep timer for stale sessions.

HTTP security: origin guard (localhost only by default), optional bearer auth via `FILESYSTEM_MCP_API_KEY`, non-loopback binding requires an API key.

### Tool system

Tools are registered via **side-effect imports** in [src/tools.ts](src/tools.ts). Each file under `src/tools/` calls `defineTool()` from [src/tools/define.ts](src/tools/define.ts), which:

1. Converts Zod schemas to MCP JSON schemas via `toMcpSchema()` ([src/schema.ts](src/schema.ts))
2. Pushes the tool definition onto `ALL_TOOLS[]`
3. On `register(deps)`, wraps the handler with observability (wide events), progress sessions, timeout signals, and optionally routes through `TaskOrchestrator` for async task support

To add a new tool: create `src/tools/<name>.ts`, call `defineTool({...})`, then add an import line in `src/tools.ts`.

### Security — PathGuard

`PathGuard` ([src/core/path.ts](src/core/path.ts)) is the single enforcer of filesystem access policy. It holds the resolved list of allowed directories and applies the sensitive-file denylist. All tool handlers receive `pathGuard` via `ToolCtx` and must call it before any filesystem operation. Path validation always happens on the main thread.

### Worker pool

`src/core/concurrency.ts` maintains a process-global lazy worker pool for CPU-bound operations (diff, patch, format). Workers are spawned from [src/core/worker.ts](src/core/worker.ts), which has **no project imports** (only `import type`) because tsx ESM hooks are not active in worker threads. Workers receive only the string payloads they need — never paths, session tokens, or `AsyncLocalStorage` state.

### Observability

`src/core/observability.ts` provides:

- `Logger` — structured log emitter
- `LogRouter` — multiplexes log targets between stdio and per-session HTTP
- `SessionContext` — `AsyncLocalStorage` for propagating session ID through async call stacks
- `emitWideEvent()` — emits canonical log-line events (one per tool execution, one per HTTP request) to a `node:diagnostics_channel`

Every tool execution emits a `tool_execution` wide event with `duration_ms`, `outcome`, `input_size_bytes`, `result_size_bytes`, etc.

### Task system

`src/tasks.ts` contains `TaskOrchestrator`, which wraps tool handlers into MCP async tasks (create / poll / cancel). Tools opt in by setting `execution.taskSupport` to `'optional'` or `'required'` in their `ToolDef`. The orchestrator uses `EventedTaskStore` (an `InMemoryTaskStore` subclass that emits cancellation events).

### Resources & prompts

- **Resources** ([src/resources.ts](src/resources.ts)): 3 built-in resources (`internal://instructions`, etc.) plus dynamic resources stored in `ResourceStore`
- **Prompts** ([src/prompts.ts](src/prompts.ts)): 4 built-in prompts (get-help, etc.)

## Key environment variables

| Variable                           | Default     | Purpose                                         |
| ---------------------------------- | ----------- | ----------------------------------------------- |
| `FILESYSTEM_MCP_API_KEY`           | —           | Bearer token for HTTP transport auth            |
| `FILESYSTEM_MCP_HTTP_HOST`         | `127.0.0.1` | HTTP bind address                               |
| `FILESYSTEM_MCP_LOG_LEVEL`         | `info`      | Min log level                                   |
| `FILESYSTEM_MCP_MAX_HTTP_SESSIONS` | `100`       | Max concurrent HTTP sessions                    |
| `FS_CONTEXT_ALLOW_SENSITIVE`       | `false`     | Allow `.env`, keys, certs                       |
| `FS_CONTEXT_DENYLIST`              | —           | Comma/newline-separated extra denylist patterns |
| `FS_DISABLE_WORKERS`               | `false`     | Disable the diff/patch worker pool              |
| `FS_WORKER_POOL_MAX`               | CPU-1       | Worker pool size cap                            |
| `MAX_FILE_SIZE`                    | 10 MiB      | Max readable file size                          |
| `MAX_SEARCH_SIZE`                  | 1 MiB       | Max file size for content search                |
| `DEFAULT_SEARCH_TIMEOUT`           | 5000 ms     | Search timeout                                  |
| `FS_INIT_HANDSHAKE_TIMEOUT_MS`     | 30000 ms    | Time to wait for `notifications/initialized`    |
| `FS_CONTEXT_STRIP_STRUCTURED`      | `false`     | Strip `structuredContent` from tool results     |

## TypeScript notes

- `tsconfig.json` is extremely strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `erasableSyntaxOnly`
- Tests use a separate `tsconfig.test.json` (includes `__tests__/`) run via `tsx` (no separate compile step)
- Module system: ESM (`"module": "NodeNext"`); all internal imports must use `.js` extensions even for `.ts` source files
- `zod/v4` is the import path (not `zod` directly) — configured at startup in `index.ts` with `z.config(z.locales.en())`
