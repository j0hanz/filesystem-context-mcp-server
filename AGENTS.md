# AGENTS.md

This file provides guidance to agents built on top of the filesystem MCP server in this repository. It covers how to interact with the server, best practices for tool usage, and tips for debugging.

## Project

Secure filesystem MCP server (Model Context Protocol) — gives AI clients sandboxed access to the local filesystem via 18 tools, 6 resources, and 4 prompts. Published to npm as `@j0hanz/filesystem-mcp`. Requires **Node.js >= 24**.

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

Individual commands (use when you need only one step):

```bash
npm run build          # Compile TypeScript to dist/
npm run type-check     # Type-check without emitting
npm run lint           # ESLint (0 warnings allowed)
npm run inspector      # Launch MCP inspector for manual testing
```

**Run a single test file:**

```sh
node --test --import tsx/esm __tests__/tools/read-write.test.ts
```

**Run a single test by name** (Node `node:test` filter):

```sh
node --test --import tsx/esm --test-name-pattern="read returns content" __tests__/tools/read-write.test.ts
```

## Architecture

### Entry point and bootstrap

- [src/index.ts](src/index.ts) — CLI bootstrapping, signal/stdin shutdown handling, dispatches to stdio or HTTP transport based on `--port`.
- [src/cli.ts](src/cli.ts) — Commander-based arg parser; validates allowed directories and Windows-specific path hazards (drive-relative, reserved device names).
- [src/server.ts](src/server.ts) → [src/server/bootstrap.ts](src/server/bootstrap.ts) — `createServer`, `startServer` (stdio), and `startHttpServer` (Node Streamable HTTP). HTTP creates **one McpServer per session** with isolated `RootsManager` state, tracks them in `activeServers` for log routing, sweeps stale half-initialized sessions, and enforces auth/origin/host rules.

### Tool registration pattern

Each tool lives in [src/tools/](src/tools/) and exports two things:

1. A `<NAME>_TOOL: ToolContract` (see [src/tools/contract.ts](src/tools/contract.ts)) — name, title, description, Zod input/output schemas, annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`), `taskSupport` level, optional `nuances`/`gotchas` strings used to generate help docs.
2. A `register<Name>Tool(server, options)` function.

[src/tools.ts](src/tools.ts) is the registry — adding a new tool means appending one entry to `TOOL_ENTRIES` and exporting the contract + register fn from the tool file. The contract is also consumed by [src/resources/tool-info.ts](src/resources/tool-info.ts) and [src/resources/tool-catalog.ts](src/resources/tool-catalog.ts) to auto-generate `internal://` documentation resources, so writing accurate `description`/`nuances`/`gotchas` is **load-bearing for the runtime help system**, not just dev docs.

### Schemas

All Zod input/output schemas are centralized in [src/schemas.ts](src/schemas.ts). Tools use `z.strictObject` (recent migration — see commit `86f6fe8`). Every tool defines `outputSchema` and returns `structuredContent`; the schema-to-JSON-Schema conversion is what clients see in `tools/list`. Setting `FS_CONTEXT_STRIP_STRUCTURED=true` strips output schemas at runtime.

### Path security model

[src/lib/paths.ts](src/lib/paths.ts) holds the trusted-path invariant: every path passed into a tool is normalized, resolved with `realpath`, and asserted to be inside an allowed root. The set of allowed directories lives in **AsyncLocalStorage** (`withAllowedDirectoriesState`) so HTTP sessions don't leak roots to each other; stdio uses a single global state. Symlink escapes, sensitive-file denylist (`.env*`, `.git`, SSH keys — [src/lib/constants.ts](src/lib/constants.ts)), and Windows-specific edge cases (drive-relative paths, reserved device names) are enforced here. Never bypass `getAllowedDirectories()`/`assertWithinAllowedDirectories()` when adding filesystem code.

### Roots and initialization

[src/server/roots-manager.ts](src/server/roots-manager.ts) owns the lifecycle: it queries the client for MCP `roots/list` after `notifications/initialized`, debounces updates, and times out clients that never finish the handshake. Tools that touch the filesystem call `isInitialized()` (passed via `ToolRegistrationOptions`) to ensure the roots are settled.

### Logging

[src/lib/logger.ts](src/lib/logger.ts) publishes log events to a `node:diagnostics_channel` (`filesystem-mcp:log`). `bootstrap.ts` subscribes once and routes each event to the correct McpServer based on `sessionId` (HTTP) or falls back to the singleton stdio server. **Do not write to `console.log`** in server code — it would corrupt stdio JSON-RPC. Use `Logger.{debug,info,notice,warn,error}` or `console.error` for raw stderr diagnostics.

### Tests

Tests in [src/**tests**/](__tests__/) use Node's native `node:test` runner via `tsx/esm`. Integration tests use [src/**tests**/linked-transport.ts](__tests__/linked-transport.ts) (an in-memory pair of MCP transports) with helpers in [src/**tests**/helpers.ts](__tests__/helpers.ts) (`createTestEnv`, `assertOk`, `assertToolError`, `getStructured`). Each test gets an isolated `mkdtemp` directory and resets `setAllowedDirectoriesResolved` on cleanup. The contract test [src/**tests**/contract.test.ts](__tests__/contract.test.ts) enforces that all 18 tools are registered with the correct annotations — update it when adding/removing tools.

## TypeScript Conventions

- Strict mode + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on. Conditionally-built objects use the `...(value ? { key: value } : {})` spread pattern (see `bootstrap.ts`, `read.ts`) instead of assigning `undefined`.
- `verbatimModuleSyntax: true` — type-only imports must use `import type` (or inline `import { type X }`). ESLint enforces this via `consistent-type-imports`.
- `module: NodeNext` — relative imports must include the `.js` extension even in `.ts` files.
- Source compiles only `src/**/*` (excluding `__tests__`); tests are type-checked separately by [tsconfig.test.json](tsconfig.test.json).
- ESLint config (`eslint.config.mjs`) extends `tseslint.strictTypeChecked` + `stylisticTypeChecked` + sonarjs + de-morgan + depend. Notable: explicit return types required, `no-floating-promises` is an error, `no-explicit-any` is an error, and naming conventions are enforced (camelCase by default; UPPER_CASE allowed for top-level constants).

## HTTP Transport Notes

When adding HTTP behavior, preserve these guarantees from `bootstrap.ts`:

- Loopback binds skip `FILESYSTEM_MCP_API_KEY` requirement; non-loopback binds **refuse to start** without it.
- Origin allowlist is localhost-only (regex check); `Host` header is also validated against `localhostAllowedHostnames()` for loopback to mitigate DNS rebinding.
- Bearer token comparison uses SHA-256 + `timingSafeEqual`.
- Request body is capped by `FS_CONTEXT_MAX_REQUEST_BYTES` and rejected with HTTP 413 / JSON-RPC error on overflow.
- Each session gets its own `RootsManager` and is cleaned up on `transport.onclose` or stale-handshake sweep.

## Release

CI in [.github/workflows/release.yml](.github/workflows/release.yml) is `workflow_dispatch`-triggered (patch/minor/major/custom). It runs `prepublishOnly` (lint + type-check + build) before tagging and publishing to npm and GHCR. Do not bypass it for releases.
