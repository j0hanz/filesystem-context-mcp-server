# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Prefer `node scripts/tasks.mjs` over individual `npm run` commands for the dev loop — it runs checks in parallel, auto-fixes where possible, and writes structured failure output.

```bash
node scripts/tasks.mjs           # format → [lint, type-check, knip] → [test, rebuild] (fail-fast)
node scripts/tasks.mjs --fix     # auto-fix format/lint/knip, then re-run all checks
node scripts/tasks.mjs --quick   # skip test + rebuild (fast static checks only)
node scripts/tasks.mjs --all     # continue past failures instead of stopping at first
node scripts/tasks.mjs --detail <n>  # show source window for the Nth test failure from last run
node scripts/tasks.mjs --watch   # run node --test in watch mode
```

```bash
npm run build          # Compile TypeScript → dist/
npm run type-check     # Type-check without emitting
npm run lint           # ESLint (zero warnings allowed)
npm run lint:fix       # ESLint with auto-fix
npm run format         # Prettier write
npm run format:check   # Prettier check
npm run knip           # Dead-code / unused-export check
npm run test           # Run all tests (node --test with tsx)
npm run check          # Full static + test suite
```

## Run a single test file

node --test --import tsx/esm "**tests**/tools/read-write.test.ts"

## Architecture

### Transport layer (`src/index.ts` → `src/server/bootstrap.ts`)

The server starts from `src/index.ts`, which parses CLI args via `src/cli.ts` (Commander) and then calls `createServer` + either `startServer` (stdio) or `startHttpServer` (Streamable HTTP via `--port`).

`startHttpServer` uses Express with an `HttpSessionRegistry` — each HTTP client gets its own `McpServer` instance with isolated state. Stdio runs a single shared instance. Both paths converge on `createServer()` in `bootstrap.ts`, which wires together all subsystems.

### Security model (`src/core/path.ts`)

`PathGuard` is the central security primitive. It enforces:

- **Allowed-directory containment**: every path is checked against `allowedDirectoriesState.expanded` (which includes symlink-resolved real paths alongside declared roots).
- **Sensitive-file denylist**: `.env`, `*.pem`, `*.key`, etc. blocked by glob matching. Override with `FS_CONTEXT_ALLOW_SENSITIVE=1`.
- **Write validation** (`validatePathForWrite`): walks up to the nearest existing ancestor to confirm the real path is within bounds before the file exists.

`PathGuard` is initialized by `RootsManager` and passed into every tool handler via `ToolCtx`.

### Roots management (`src/server/roots-manager.ts`)

`RootsManager` resolves allowed directories from three sources (in priority order):

1. CLI positional args (`--allow-cwd` / explicit dirs)
2. `--allow-cwd` current working directory
3. MCP Roots protocol (client-sent `roots/list_changed` notifications, filtered to stay within CLI baseline)

On `notifications/initialized`, the manager fetches roots from the client and recomputes `PathGuard` state. Root changes are debounced (100 ms).

### Tool system (`src/tools/define.ts`, `src/tools/*.ts`)

All 14 tools are defined with `defineTool()` which populates `ALL_TOOLS[]`. Import side-effects in `src/tools.ts` trigger registration. Each `ToolDef` declares:

- `annotations`: `readOnly` | `idempotentWrite` | `destructiveWrite` (maps to MCP hints)
- `task`: `forbidden` | `optional` | `required` — controls whether the tool is registered as a task-capable tool via `TaskOrchestrator`
- `run`: async handler receiving `(args, ToolCtx)` where `ToolCtx` has `signal`, `pathGuard`, `resourceStore`, `onProgress`, `elicitInput`

`defineTool()` handles Zod validation, timeout signals (`AbortSignal.any`), progress sessions, and structured output (`{ content, structuredContent }`).

### Worker threads (`src/core/worker.ts`, `src/core/concurrency.ts`)

CPU-heavy operations (diff, patch, hash) are offloaded to a pool of Node.js worker threads via `runInWorker()`. Workers receive only the string data they need — no paths, no session state. Path validation always happens on the main thread before dispatch. Pool size is auto-tuned from CPU cores (`FS_WORKER_POOL_MAX`).

### Resources & prompts (`src/resources.ts`, `src/prompts.ts`)

Resources expose filesystem views as MCP resources (URI scheme `internal://`). `ResourceStore` is an in-memory key-value store for caching resource content. The `get-help` prompt and `internal://instructions` resource provide guidance to the LLM client.

### Schema layer (`src/schemas/`)

`src/schemas/json-schema.ts` bridges Zod v4 schemas to MCP-compatible JSON Schema via `toToolJsonSchema()`. `src/schemas/fields.ts` houses reusable Zod field definitions shared across tools.

## Key environment variables

| Variable                           | Default       | Purpose                                                |
| ---------------------------------- | ------------- | ------------------------------------------------------ |
| `FS_CONTEXT_ALLOW_SENSITIVE`       | `false`       | Bypass sensitive-file denylist                         |
| `FS_CONTEXT_DENYLIST`              | `""`          | Extra glob patterns to block (comma/newline separated) |
| `MAX_FILE_SIZE`                    | 10 MiB        | Max readable text file size                            |
| `MAX_SEARCH_SIZE`                  | 1 MiB         | Max file size for content search                       |
| `MAX_READ_MANY_TOTAL_SIZE`         | 512 KiB       | Aggregate size cap for `read-multiple`                 |
| `DEFAULT_SEARCH_TIMEOUT`           | 5000 ms       | Search timeout                                         |
| `FS_WORKER_POOL_MAX`               | CPU-1 (max 4) | Worker thread pool size                                |
| `FS_DISABLE_WORKERS`               | `false`       | Disable worker-thread offload                          |
| `FILESYSTEM_MCP_LOG_LEVEL`         | `info`        | MCP logging level                                      |
| `FILESYSTEM_MCP_API_KEY`           | unset         | Bearer token for HTTP mode                             |
| `FILESYSTEM_MCP_HTTP_HOST`         | `127.0.0.1`   | HTTP bind address                                      |
| `FILESYSTEM_MCP_MAX_HTTP_SESSIONS` | 100           | Max concurrent HTTP sessions                           |
| `FS_INIT_HANDSHAKE_TIMEOUT_MS`     | 30000         | Max wait for client `initialized`                      |
| `FS_CONTEXT_STRIP_STRUCTURED`      | `false`       | Strip `structuredContent` from responses               |

## Adding a new tool

1. Create `src/tools/<name>.ts` — call `defineTool()` and export the result as a named constant.
2. Import that constant in `src/tools.ts` and add it to the `void [...]` array.
3. The tool is auto-registered into `ALL_TOOLS` on import; no further wiring needed.
4. Add a snapshot entry if the tool affects `__tests__/schemas/__snapshots__/tool-schemas.json`.

## Testing

Tests live in `__tests__/` and use Node's built-in `node:test` runner with `tsx` for TypeScript. Integration tests spin up real in-process MCP servers via helpers in `__tests__/helpers.ts` and `__tests__/linked-transport.ts` — no mocking of the filesystem or MCP layer.

Schema snapshots in `__tests__/schemas/__snapshots__/tool-schemas.json` lock the tool input/output contracts; update them deliberately when changing schemas.
