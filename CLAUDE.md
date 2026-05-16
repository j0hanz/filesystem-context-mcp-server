# CLAUDE.md

## Project Overview

This project (`@j0hanz/filesystem-mcp`) is a Model Context Protocol (MCP) server that provides secure filesystem operations (reading, writing, searching, diffing, and patching files) to AI models. It uses the official `@modelcontextprotocol` SDKs.

### Architecture & Tech Stack

- **Runtime:** Node.js (>= v24)
- **Language:** TypeScript with strict type checking.
- **Validation:** Zod (`zod/v4`).
- **Transports:** Stdio and HTTP (Express).
- **Core Concepts:** Implements an MCP Server exposing tools, resources, and prompts. Uses worker threads for concurrency and offloading.

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

## Coding Conventions & Guidelines

- **ES Modules:** The project uses native ES Modules (`"type": "module"` in `package.json`, `NodeNext` resolution).
- **Built-in Modules:** Always use the `node:` prefix when importing Node.js built-in modules (e.g., `import fs from 'node:fs';`).
- **Strict Typing:**
  - Leverage TypeScript's strict mode.
  - Avoid `any`. ESLint rules enforce strict type checking (`strictTypeChecked`, `stylisticTypeChecked`).
  - Use `unknown` for errors in catch blocks.
- **Promise Handling:** No floating promises. Always `await` or explicitly mark as `void`.
- **Error Handling & Logging:**
  - **Do NOT log to `stdout` (`console.log`)**. This breaks the MCP Stdio protocol. Use `console.error` for diagnostic logging.
  - Custom error handling and observability are routed through `src/core/observability.ts`.
- **Unused Variables:** Prefix intentionally unused parameters or variables with `_` to satisfy ESLint.
- **Tests:** Test files are located in `__tests__/` and end with `.test.ts`. Tests use looser ESLint rules for ergonomics but still enforce correctness.
