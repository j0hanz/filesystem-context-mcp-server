# Agent Instructions

## Project

- Secure filesystem MCP server for reading, writing, searching, diffing, and patching files
- TypeScript (strict, ES2024, ESM) + Node.js >=24, MCP SDK v2, Zod v4

## Hard Rules

- Free-form commit messages allowed (see `pr-workflow` skill)
- Breaking changes are fine. Never add fallback/legacy-compat shims; rewrite to the better approach directly
- Test/typecheck only files you changed; do not require full-suite runs
- Automated CI runs on GitHub Actions

## Package Manager

- npm

### Common Commands

| Mode                | Command                             |
| ------------------- | ----------------------------------- |
| Full check          | `node scripts/tasks.mjs`            |
| Auto-fix + check    | `node scripts/tasks.mjs fix`        |
| Static only         | `node scripts/tasks.mjs --quick`    |
| Tests only          | `node scripts/tasks.mjs test`       |
| Test failure detail | `node scripts/tasks.mjs detail [n]` |

## Dependency Locations

- `node_modules/`

## Key Conventions

- `src/server.ts` = protocol server entry
- `src/cli.ts` = CLI entry
- Shared code lives in `src/core/` and `src/tools/`
- Use `runOverPaths()` (`src/tools/define.ts`)
- Support per-path concurrency and partial-failure results
- Throw `FsError` carrying a `Problem` (`src/core/errors.ts`)
- Never throw raw `Error`
- Use `Problem.notFound()`, `Problem.invalidInput()`, etc.
- ESM only
- Relative imports require explicit `.js` extensions
- All access goes through `GuardedFileSystem` / `PathGuard`
- Never use `node:fs` directly in tool code
- See `src/core/fs.ts` and `src/core/path.ts`
- Each tool lives in `src/tools/<name>.ts`
- Build tools with `defineTool()` (`src/tools/define.ts`)
- Register tools in `src/tools/index.ts`
- Zod:
  - Import as:

    ```ts
    import * as z from 'zod/v4';
    ```

  - Never import from bare `zod`

<!-- project-init:hard-rules v1 commit=relaxed maturity=development testing=touched-files ci=github-actions sections=none -->
