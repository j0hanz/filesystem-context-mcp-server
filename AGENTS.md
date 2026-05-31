# filesystem-mcp Agent Instructions

Secure server exposing filesystem read, write, search, and patch operations with path-guard sandboxing.

## Package Manager

Use **npm** — `npm install`, `npm run build`, `npm test`. Do not use pnpm or yarn (no lockfile for them).

## File-Scoped Commands

| Task       | Command                                                               |
| ---------- | --------------------------------------------------------------------- |
| Typecheck  | `npm run type-check` (project-wide; tsc has no single-file mode here) |
| Lint       | `npm run lint` · single file: `npx eslint src/tools/edit.ts`          |
| Format     | `npm run format` · check only: `npm run format:check`                 |
| Test       | `node --test --import tsx __tests__/tools/edit-multi.test.ts`         |
| Test (all) | `npm test`                                                            |
| Full check | `npm run check` (build + typecheck + lint + format + knip + test)     |

## Key Conventions

- **New tools**: Add `src/tools/<name>.ts` calling `defineTool()` from `src/tools/define.ts`; declare both input **and** output Zod schemas (both are required at runtime — omitting output causes an MCP contract violation).
- **Zod imports**: Always import as `import { z } from 'zod/v4'` — not `'zod'` (project-specific alias; using plain `'zod'` is a runtime error).
- **Error construction**: Use typed factories such as `Problem.notFound()`, `Problem.ioError()`, `Problem.accessDenied()` from `src/core/errors.ts`; use `Problem.fromUnknown(error, ErrorCode.IO_ERROR, path)` only in catch-clause re-wrapping (e.g., inside `runOverPaths`).
- **Path safety**: All filesystem access in tool handlers must use `ctx.fs` (`GuardedFileSystem`); never import `node:fs` directly in `src/tools/`.
- **Batch operations**: Multi-path tools use `runOverPaths()` from `src/tools/define.ts`; returns `BatchResult<T>` with per-path errors, not a thrown exception.
- **Safe regex**: Use `import RE2 from 're2'` (not native `RegExp`) for any user-supplied pattern to prevent ReDoS.
- **ESM imports**: All relative imports require `.js` extension (e.g., `import ... from '../core/errors.js'`).

## Commit Attribution

AI commits MUST include a `Co-Authored-By:` trailer.
Example: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
