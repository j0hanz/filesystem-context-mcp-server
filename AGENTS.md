# AGENTS.md

## 1. Overview

A secure filesystem Model Context Protocol (MCP) server that provides AI clients sandboxed access to local workspaces via a suite of tools for reading, writing, diffing, searching, and patching files.

## 2. Folder Structure

- `src/lib/`: Core filesystem primitives, path security logic (`path-guard.ts`), custom error mapping, observability, and concurrent file operation utilities (`parallel.ts`, `atomic-write.ts`, `fs-walk.ts`).
- `src/server/`: Transport bootstrapping, session initialization sequence (`roots-manager.ts`), and long-running background task orchestration.
- `src/tools/`: The MCP tool definitions. Each tool exports its specific contract and logic, registered centrally via `define-tool.ts`.
- `src/resources/`: Internal configurations and instructions exposed as standard MCP resources.
- `src/schemas/`: Centralized Zod output schemas defining structured JSON payload payloads.
- `__tests__/`: Extensive unit and integration tests using native `node:test` and linked in-memory transports (`linked-transport.ts`).

## 3. Core Behaviors & Patterns

- **Path Security Model**: File operations strictly adhere to a trusted-path invariant enforced by `PathGuard.assertWithinAllowedDirectories()`. This ensures OS-specific hazards (Windows drive letters), symlink escapes, and restricted system files (e.g., `.env`, `.git`) are blocked prior to FS access.
- **Error Propagation**: Internal failures are systematically mapped to standard MCP JSON-RPC error codes using `createDetailedError` and the `Problem` model inside `lib/errors.ts`, ensuring predictable error payloads for LLM clients.
- **Tool Interception**: MCP tools define specific schemas in `contract.ts` and are injected into the transport layer via `defineTool()`, which transparently wraps the execution with performance metrics and structured diagnostics (`executeToolWithDiagnostics`).
- **Resilience & Cancellations**: Sessions validate operating roots via `RootsManager`. Long-running tasks use `AbortController`s injected by the `TaskOrchestrator`, providing deterministic cancellation when clients trigger abortions.

## 4. Conventions

- **Schema Strictness**: All Zod payload definitions use `strictObject()` to categorically reject unknown input keys. Optional properties are assigned using conditional spreads (`...(value ? { key: value } : {})`) rather than explicit `undefined`, complying with the `exactOptionalPropertyTypes` TypeScript setting.
- **Typing & Imports**: The codebase enforces `import type` for type-only dependencies and mandates `.js` file extensions on relative imports to satisfy `NodeNext` module resolution.
- **No Console Logging**: Direct `console.log` invocations are forbidden to prevent corruption of the `stdio` JSON-RPC streams. Logging flows through a central `Logger` that publishes to a `node:diagnostics_channel`, cleanly routed via the `LogRouter`.
- **Asynchronous Execution**: Directory traversals and batch operations rely on fixed-concurrency limits (`processInParallel` in `lib/parallel.ts`) rather than unbounded `Promise.all` calls to avoid starving resources on large directories.

## 5. Working Agreements

- Respond in user's preferred language; if unspecified, infer from codebase (keep tech terms in English, never translate code blocks)
- Ask the user before introducing tests, lint, or formatter setups; add them only on explicit request
- Build context by reviewing related usages, flows, patterns, and likely impact before editing
- Fix the underlying cause, not only the visible symptom; inspect affected flows and apply the narrowest complete change that resolves the root issue
- Check side effects across callers, shared abstractions, and behavior/API boundaries; report relevant impact and compatibility risks
- Ask actively when user decisions are needed for scope, behavior, or tradeoffs
- Run type-check after code changes using `npm run type-check`
- In monorepos, put package-only tests/type-check/verification guidance in the package-level AGENTS.md, not the root document
- New functions: single-purpose, colocated with related code
- External dependencies: only when necessary, explain why
