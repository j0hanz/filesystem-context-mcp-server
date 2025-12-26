# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the TypeScript source. Entry points are `src/index.ts` (CLI) and `src/server.ts` (server wiring).
- Core logic lives in `src/lib/`, MCP tool wrappers in `src/tools/`, and Zod schemas in `src/schemas/`.
- Tests live in `src/__tests__/` and follow the `src/**/*.test.ts` naming pattern.
- `dist/` is build output, `docs/` holds documentation assets, `scripts/` contains utilities, and `benchmark/` and `coverage/` are generated outputs.

## Build, Test, and Development Commands

- `npm run build` compiles TypeScript and copies `src/instructions.md` into `dist/`.
- `npm run dev` runs watch mode via `tsx` for local development.
- `npm run start` runs the compiled server from `dist/`.
- `npm run test`, `npm run test:watch`, and `npm run test:coverage` run Vitest (coverage uses V8 reporters).
- `npm run lint`, `npm run format`, and `npm run type-check` enforce linting, formatting, and type checks.
- `npm run bench` runs benchmarks; `npm run inspector` launches the MCP Inspector.

## Coding Style & Naming Conventions

- TypeScript (ESM) with 2-space indentation, semicolons, single quotes, and 80-column wrapping (Prettier).
- Import order is enforced by `@trivago/prettier-plugin-sort-imports` (node built-ins, deps, then local).
- ESLint + `typescript-eslint` is strict: prefer type imports, explicit return types, camelCase/PascalCase naming, no `any`, and no unused imports.
- Do not hand-edit `dist/`; regenerate with `npm run build`.

## Testing Guidelines

- Vitest runs in a Node environment with `src/**/*.test.ts` files (mostly under `src/__tests__/`).
- Coverage focuses on `src/lib/**/*.ts` and excludes test files.
- Add tests for security boundaries and path validation when changing filesystem behavior.

## Commit & Pull Request Guidelines

- Recent history uses Conventional Commits (for example, `feat: add tool`) and version-only release commits like `1.3.0`. Follow the same pattern.
- PRs should include a short summary, tests run, and any relevant doc or config updates. Link issues when available.

## Security and Configuration Notes

- This server is read-only by design; avoid adding write or delete behavior.
- Configuration and environment variables are documented in `CONFIGURATION.md`. Update it when adding options.
- Agent-facing tool guidance lives in `src/instructions.md` and is bundled into `dist/` during builds.
