# Filesystem MCP Server - Gemini Instructions

Comprehensive instructions and context for developing, testing, and maintaining the Filesystem MCP Server.

## Project Overview

A secure Model Context Protocol (MCP) server that provides local filesystem operations (reading, writing, searching, etc.) to LLM clients. Built with **TypeScript** and **Node.js (>=24)**, it supports both **stdio** and **HTTP** transports.

### Core Architecture

- **`McpServer`**: The primary entry point for MCP communication.
- **`PathGuard`**: The security centerpiece. Validates every path against allowed roots and a sensitive-file denylist.
- **`RootsManager`**: Orchestrates allowed directories from CLI arguments and dynamic MCP Roots notifications.
- **`WorkerPool`**: Offloads CPU-intensive tasks (e.g., recursive search, hash calculation) to prevent blocking the main event loop.
- **Tool System**: Uses a custom `defineTool` engine for consistent validation, error handling, and observability.
- **Task System**: Manages long-running or background operations via `TaskOrchestrator`.

## Key Commands (Dev Loop)

The project uses `scripts/tasks.mjs` as the primary dev-loop driver.

- **Check Everything**: `npm run check` (or `node scripts/tasks.mjs check`)
  - Runs: `format` → `[lint, type-check, knip]` → `[test, rebuild]`.
- **Auto-Fix**: `node scripts/tasks.mjs fix`
  - Fixes format, lint, and knip issues automatically.
- **Run Tests**: `npm test` (or `node scripts/tasks.mjs test`)
  - Runs tests in `__tests__` using `node --test` and `tsx`.
  - Support flags: `--name-pattern <regex>`, `--timeout <ms>`, `--shard <i/n>`, `--update-snapshots`.
- **Build**: `npm run build`
  - Compiles TypeScript to `dist/`.
- **Static Analysis**: `npm run type-check`, `npm run lint`, `npm run knip`.
- **Debug Tests**: `node scripts/tasks.mjs detail <n>`
  - Shows source code context for the Nth failure from the previous test run.

## Development Conventions

### Security First (PathGuard)

- **Never bypass `PathGuard`**. All file operations must use `pathGuard.validateExistingPath()`, `validateExistingDirectory()`, or `validatePathForWrite()`.
- Sensitive files (e.g., `.git`, `.env`, SSH keys) are blocked by default.
- Paths are always normalized and resolved to their real path (resolving symlinks) before access.

### Tool Implementation

- Define tools in `src/tools/` using the `defineTool` helper from `src/tools/define.ts`.
- Use **Zod (v4)** for input and output schemas.
- Tools should return a `RunResult` containing `structured` data and optional `text` or `resources`.
- Error handling: Use `McpError` with appropriate `ErrorCode` for consistent client feedback.

### Code Style

- **ESM Only**: The project is `type: module`. Use `.js` extensions in imports (e.g., `import { x } from './y.js'`).
- **Strict Typing**: No `any`. Use specific types for errors and unknown values.
- **Async/Await**: Prefer `fs/promises` for all filesystem operations.
- **Logging**: Use `Logger` from `src/core/observability.ts`. Avoid `console.log` in production code.

### Testing

- Tests are located in `__tests__/`.
- Use `node:test` (built-in) and `tsx` for ESM support.
- Organize tests into `unit/`, `tools/`, and integration tests.
- Always add a reproduction test case for bug fixes.

## Project Structure

- `src/core/`: Foundation logic (concurrency, errors, fs, observability, path security).
- `src/tools/`: Implementation of all MCP tools.
- `src/server.ts`: MCP server setup, handler registration, and capability building.
- `src/transport.ts`: stdio and HTTP transport implementations.
- `__tests__/`: Comprehensive test suite.
- `scripts/`: Dev-loop and maintenance scripts.
- `.claude/`: Detailed architectural and environment specs (useful reference).
