# AGENTS.md

## Project Overview

- Package: `@j0hanz/fs-context-mcp` (read-only filesystem exploration MCP server)
- Language/runtime: TypeScript (ESM) on Node.js `>=20.0.0`
- Entry points:
  - Source entry: `src/index.ts`
  - CLI bin: `fs-context-mcp` → `dist/index.js`
- MCP SDK: `@modelcontextprotocol/sdk` (server)

## Repo Map / Structure

- `src/`: TypeScript source
  - `src/index.ts`: CLI entry; sets allowed roots from CLI/MCP Roots; starts stdio server
  - `src/server.ts`: MCP server setup + CLI arg parsing
  - `src/tools.ts`: tool registration and tool response helpers
  - `src/schemas.ts`: Zod schemas for tool inputs/outputs
  - `src/lib/`: core logic
    - `src/lib/path-validation.ts`: allowed roots + boundary checks (incl. Windows path rules)
    - `src/lib/file-operations/`: implementations for ls/find/grep/read/stat
    - `src/lib/observability.ts`: tracing/diagnostics wrappers
  - `src/__tests__/`: Node test runner tests (TypeScript via `tsx/esm`)
- `node-tests/`: additional Node test runner tests (non-glob entry)
- `docs/`: static docs assets (e.g., `docs/logo.png`)
- `dist/`: build output (generated)
- `scripts/` + `metrics/`: local quality/metrics artifacts
- `.github/workflows/publish.yml`: release → publish pipeline

## Setup & Environment

- Requirements:
  - Node.js `>=20.0.0`
  - npm (repo includes `package-lock.json`)

- Install deps:
  - `npm install`

- Configuration docs:
  - `CONFIGURATION.md`
  - `README.md` (“Configuration” section)

- Optional environment variables (bytes/ms):
  - `MAX_FILE_SIZE`
  - `MAX_SEARCH_SIZE`
  - `DEFAULT_SEARCH_TIMEOUT`
  - `FS_CONTEXT_SEARCH_WORKERS`

## Development Workflow

- Dev (watch): `npm run dev`
- Build: `npm run build`
- Start (run compiled stdio server): `npm run start`
- Format: `npm run format`
- Lint: `npm run lint`
- Type-check: `npm run type-check`

Notes:

- `npm run build` runs `tsc -p tsconfig.build.json`, validates `src/instructions.md` exists, then copies it to `dist/instructions.md`.
- `src/index.ts` starts the MCP server on stdio; do not write non-MCP data to stdout.

## Testing

- All tests: `npm run test`
- Watch mode: `npm run test:watch`
- Coverage: `npm run test:coverage`
- Node-only targeted test: `npm run test:node`

Test locations/patterns:

- Main suite: `src/__tests__/**/*.test.ts` (executed via Node’s test runner with `--import tsx/esm`)
- Additional suite: `node-tests/*.test.ts`

## Code Style & Conventions

- Formatting:
  - Prettier: `npm run format`
  - Prettier config: `.prettierrc` (includes import sorting plugin)

- Linting:
  - ESLint: `npm run lint`
  - Config: `eslint.config.mjs` (TypeScript-aware linting; strict rules)

- TypeScript:
  - Type-check: `npm run type-check` (uses `tsconfig.typecheck.json`)
  - ESM/NodeNext: local imports use `.js` extensions in source (see existing patterns)

## Build / Release

- Build output: `dist/`
- Prepublish checks: `npm run prepublishOnly` (runs `lint`, `type-check`, then `build`)
- Release automation:
  - GitHub Actions workflow: `.github/workflows/publish.yml` publishes on GitHub Release “published”
  - Workflow runs: `npm ci` → `npm run lint` → `npm run type-check` → `npm run test` → `npm run build` → `npm publish --access public`

## Security & Safety

- This server is read-only: tools should not modify the filesystem.
- Path safety is enforced by “allowed roots” + boundary checks (see `src/lib/path-validation.ts`).
- Symlinks are not followed outside allowed roots.

Agent safety rules for changes:

- Prefer extending existing tool patterns in `src/tools.ts` and schemas in `src/schemas.ts`.
- Keep tool inputs bounded with Zod `.min()`/`.max()` and prefer `z.strictObject()`.
- For stdio transport: never write non-protocol output to stdout (use `console.error()` for logs).

## Pull Request / Commit Guidelines

- No commit message convention is documented in this repo.
- Before opening a PR, run at least:
  - `npm run format`
  - `npm run lint`
  - `npm run type-check`
  - `npm run build`
  - `npm run test`

## Troubleshooting

- Build fails with missing instructions asset:
  - `npm run build` requires `src/instructions.md` and copies it to `dist/instructions.md`.

- Server/client communication issues:
  - Ensure you are not writing to stdout (stdio transport).
  - Use the inspector: `npx @modelcontextprotocol/inspector`

- Windows path issues:
  - Drive-relative paths like `C:path` are rejected; use `C:\path` or `C:/path`.

## Open Questions / TODO

- `.vscode/mcp.json` contains provider configuration for local MCP tooling; ensure secrets are not committed (prefer `${input:...}` placeholders).
- `.github/instructions/typescript-mcp-server.instructions.md` mentions Zod v3, but `package.json` depends on Zod v4; reconcile the instruction doc with the repo’s actual dependency.
