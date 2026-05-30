# AGENTS.md

Path-guarded filesystem server implementing the Model Context Protocol over stdio or HTTP.

## Package Manager

Use **npm** — `npm install`, `npm test`, `npm run build`. Do not use pnpm or yarn; the lockfile is `package-lock.json`.

## File-scoped commands

| Task      | Command                                                        |
| --------- | -------------------------------------------------------------- |
| Typecheck | `npm run type-check` (project-wide; tsc has no per-file mode)  |
| Lint      | `npx eslint src/path/to/file.ts`                               |
| Test      | `node --test --import tsx "__tests__/path/to.test.ts"`         |

Full gate before committing: `npm run check` (build + type-check + lint + format + knip + tests).

## Key Conventions

- Each tool lives in `src/tools/<name>.ts` and exports a single ALL_CAPS constant (`CREATE`, `EDIT`, etc.) implementing `ToolDef<I, O>` from `src/tools/define.ts`. Register new tools in `src/server.ts`.
- Error handling: use the `Problem` factory in `src/core/errors.ts` (`Problem.notFound(...)`, `Problem.accessDenied(...)`, etc.); tool handlers return `ToolResult` — never throw from a handler.
- Schemas use `zod/v4` import path, not `zod`.
- Tests: integration tests in `__tests__/tools/`, unit tests in `__tests__/unit/`. The runner is Node.js built-in (`node --test`).
- `src/core/` is shared infrastructure (path guarding, fs, errors, observability); keep tool-specific logic in `src/tools/`.

## Commit Attribution

AI commits MUST include a `Co-Authored-By:` trailer.
Example: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
