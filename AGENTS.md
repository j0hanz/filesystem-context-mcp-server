# Repository Guidelines

## Project Structure & Module Organization

- `src/index.ts` is the CLI entry; `src/server.ts` wires MCP roots and startup; `src/instructions.md` is bundled for clients.
- `src/tools/` holds MCP tool handlers; `src/lib/` contains filesystem helpers, formatters, and path validation; `src/schemas/` defines Zod inputs/outputs; `src/config/` keeps shared types.
- Tests mirror code in `src/__tests__/lib`, `src/__tests__/schemas`, and `src/__tests__/security`.
- Build artifacts live in `dist/`; docs and assets are in `docs/`; utility scripts sit in `scripts/`.

## Build, Test, and Development Commands

- `npm install` (Node >=20) to set up dependencies.
- `npm run dev` start watch mode via tsx for rapid edits.
- `npm run build` compile TypeScript and copy `src/instructions.md` into `dist/`.
- `npm run start` execute the compiled server from `dist/index.js`.
- `npm run test` | `npm run test:watch` | `npm run test:coverage` run Vitest suites.
- `npm run lint`, `npm run type-check`, `npm run format` enforce style and correctness.
- `npm run inspector` opens MCP Inspector to exercise tools interactively.

## Coding Style & Naming Conventions

- TypeScript strict; prefer explicit returns and pure helpers.
- Prettier: 2-space indent, semicolons, single quotes, 80-char width; imports auto-ordered (node -> externals -> internal -> relative).
- ESLint: no `any`; require type-only imports; naming defaults to camelCase, PascalCase for types/enums, UPPER*CASE for constants; `*`-prefixed params allowed when unused.

## Testing Guidelines

- Vitest + V8 coverage; place specs under `src/__tests__/**` with `*.test.ts` names.
- Keep security boundary cases in `src/__tests__/security/`; prefer temp dirs and deterministic paths in FS tests.
- Run `npm run test:coverage` for new features and avoid coverage regression.

## Security & Configuration Tips

- Server is intentionally read-only; do not add write operations to tools.
- Route new filesystem access through `src/lib/path-validation.ts` and related helpers.
- Tune limits via env vars in `CONFIGURATION.md` (e.g., `MAX_FILE_SIZE`, `PARALLEL_JOBS`); avoid raising defaults without justification.

## Commit & Pull Request Guidelines

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`) consistent with repo history.
- Before opening a PR, run `npm run lint && npm run type-check && npm run test` and note results.
- PRs should include a concise summary, linked issue (if any), security impact notes, and sample CLI/Inspector steps.
- Omit `dist/` and `logs/` from commits unless preparing a release that requires built assets.
