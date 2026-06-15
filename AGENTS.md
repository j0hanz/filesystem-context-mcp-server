# filesystem-mcp Agent Instructions

TypeScript/Node.js server that exposes filesystem operations (read, write, search, diff, patch) over the Model Context Protocol.

## Package Manager

Use **npm** — `npm install`, `npm run build`, `npm test`.

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

- New tools go in `src/tools/<name>.ts` and must be registered in `src/tools/index.ts` — follow the `defineTool()` pattern from `src/tools/define.ts`.
- `defineTool` requires dual Zod schemas: one for `input`, one for `output`; import Zod as `import * as z from 'zod/v4'`.
- Filesystem access only through `ctx.fs` (`GuardedFileSystem`) — never import `node:fs` directly in tool files.
- Batch/multi-path tools use `runOverPaths()` from `src/tools/define.ts`; single-path tools call the per-path logic directly.
- User-supplied regex patterns must use `RE2` (not built-in `RegExp`) to prevent ReDoS.
- ESM project — all intra-package imports use `.js` extensions even for `.ts` source files.
- Errors: use `Problem` factories from `src/core/errors.ts`; `FsError` for filesystem faults, `Problem.fromUnknown` in catch blocks.

## Critical Files

- `src/tools/define.ts` — `defineTool`, `runOverPaths`, `ToolCtx`, `ToolDef` types; read before adding a tool.
- `src/core/fs.ts` — `GuardedFileSystem` API; read before any filesystem operation.
- `src/core/errors.ts` — `ErrorCode`, `Problem`, `FsError`; use these for all error paths.
