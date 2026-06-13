# filesystem-mcp Agent Instructions

Secure filesystem server (TypeScript/Node ≥24, ESM) implementing the Model Context Protocol to expose file operations to LLM clients.

## Package Manager

Use **npm** — `npm install`, `npm run build`, `npm test`. Do not use `pnpm` or `yarn`; they will break `package-lock.json`.

## Dependency Locations

- Node dependencies: `node_modules/`
- Build output: `dist/`

## Dev-Loop Orchestrator

Use `node scripts/tasks.mjs` (aliased as `npm run tasks`) for all dev-loop work — it runs checks in the right order with parallelism, adaptive timeouts, and structured failure output.

| Mode                | Command                             |
| ------------------- | ----------------------------------- |
| Full check          | `node scripts/tasks.mjs`            |
| Auto-fix + check    | `node scripts/tasks.mjs fix`        |
| Static only         | `node scripts/tasks.mjs --quick`    |
| Tests only          | `node scripts/tasks.mjs test`       |
| Test failure detail | `node scripts/tasks.mjs detail [n]` |

## File-Scoped Commands

| Task      | Command                                                    |
| --------- | ---------------------------------------------------------- |
| Typecheck | `npx tsc -p tsconfig.json --noEmit`                        |
| Lint      | `npx eslint src/path/to/file.ts`                           |
| Format    | `npx prettier --check src/path/to/file.ts`                 |
| Test      | `node --test --import tsx "__tests__/unit/errors.test.ts"` |

## Key Conventions

- **Tool definitions**: Define every tool with `defineTool()` ([src/tools/define.ts](src/tools/define.ts)); both `input` and `output` Zod schemas are required. Multi-path operations must use `runOverPaths()` for consistent progress tracking and error collection.
- **Errors**: Throw `Problem.*()` factories (e.g., `Problem.notFound(...)`) or `FsError` from [src/core/errors.ts](src/core/errors.ts). Never throw plain `new Error()` in tool or core code; use `classify()` to map unknown errors.
- **Filesystem access**: All filesystem ops in tools must go through `ctx.fs` (`GuardedFileSystem`) — never import `node:fs` directly in `src/tools/`.
- **Zod imports**: Use `import * as z from 'zod/v4'` — not `from 'zod'` or `from 'zod/v4/mini'`.
- **Regex safety**: Use RE2 (not native `RegExp`) for any user-supplied patterns to prevent ReDoS.
- **ESM imports**: Local imports use `.js` extension even for `.ts` source files (e.g., `import { foo } from './bar.js'`).
- **Tests**: Unit tests live in `__tests__/unit/`; integration tests in `__tests__/tools/`. Run with Node's built-in test runner — no Jest config.

## Commit Attribution

AI commits MUST include a `Co-Authored-By:` trailer.
Example: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
