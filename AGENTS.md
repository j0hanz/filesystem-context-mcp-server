# Agent Instructions

purpose: Secure filesystem server (Model Context Protocol) for reading, writing, searching, diffing, and patching files.

## Hard Rules

commit: free-form commit messages allowed; every AI commit MUST include a `Co-Authored-By:` trailer
maturity: breaking changes are fine — never add fallback/legacy-compat shims, rewrite to the better approach directly
testing: every change must have passing tests before being called done

<!-- codebase-init:hard-rules v1 commit=relaxed maturity=development testing=always -->

## Package Manager

pm: npm
install: `npm install`
build: `npm run build`
start: `npm start`
test: `npm test`
typecheck: `npm run type-check`
lint: `npm run lint`
check: `npm run check` (build + type-check + eslint + prettier + knip + test)

## Dependency Locations

node_modules: `node_modules/`

## Common Commands

| Mode                | Command                             |
| ------------------- | ----------------------------------- |
| Full check          | `node scripts/tasks.mjs`            |
| Auto-fix + check    | `node scripts/tasks.mjs fix`        |
| Static only         | `node scripts/tasks.mjs --quick`    |
| Tests only          | `node scripts/tasks.mjs test`       |
| Test failure detail | `node scripts/tasks.mjs detail [n]` |

## Key Conventions

architecture: monolith + CLI — `src/server.ts` (protocol server entry) and `src/cli.ts` (CLI entry) share `src/core/` and `src/tools/`
tools: each tool lives in `src/tools/<name>.ts`, built via `defineTool()` ([define.ts](src/tools/define.ts)) and registered in [index.ts](src/tools/index.ts)
errors: throw `FsError` carrying a `Problem` ([errors.ts](src/core/errors.ts)); never throw raw `Error` — use `Problem.notFound()`, `Problem.invalidInput()`, etc.
batch-ops: multi-path tools use `runOverPaths()` ([define.ts](src/tools/define.ts)) for per-path concurrency and partial-failure results
imports: ESM only — relative imports require explicit `.js` extensions
zod: import as `import * as z from 'zod/v4'` (not bare `zod`)
path-safety: all filesystem access goes through `GuardedFileSystem`/`PathGuard` ([fs.ts](src/core/fs.ts), [path.ts](src/core/path.ts)) — never use `node:fs` directly in tool code

## Commit Attribution

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
