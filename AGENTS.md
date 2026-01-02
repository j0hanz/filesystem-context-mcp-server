# AGENTS.md

## Project Overview

- **Package:** `@j0hanz/filesystem-context-mcp` (v1.3.5)
- **Purpose:** Read-only MCP server for secure filesystem exploration, searching, and analysis
- **Stack:** TypeScript 5.9, Node.js 20+, MCP SDK 1.25, Zod, fast-glob, RE2
- **Architecture:** CLI entry → MCP server → tools layer → lib (core logic) → schemas (Zod I/O)
- **License:** MIT

## Repo Map / Structure

```text
src/
  index.ts              # CLI entry point (parses args, starts server)
  server.ts             # MCP server wiring and roots handling
  instructions.md       # Tool usage docs (bundled to dist/)
  config/               # Shared types, formatting helpers
  lib/                  # Core filesystem logic (path validation, file ops, helpers)
  schemas/              # Zod input/output schemas for all tools
  tools/                # MCP tool registration (one file per tool)
  __tests__/            # Test files (node:test + tsx)
dist/                   # Build output (gitignored)
docs/                   # Documentation assets
scripts/                # Benchmarks and utilities
coverage/               # Test coverage reports (gitignored in CI)
```

- **Source of truth for types:** `src/schemas/` (Zod schemas define all tool I/O)
- **Generated output:** `dist/` — never edit directly
- **Entry point:** `dist/index.js` (bin: `filesystem-context-mcp`)

## Setup & Environment

- **Install deps:** `npm install`
- **Node version:** `>=20.0.0` (see `engines` in `package.json`)
- **Package manager:** npm
- **Environment config:** See [CONFIGURATION.md](CONFIGURATION.md) for env variables (all optional)

## Development Workflow

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Watch mode with tsx                   |
| `npm run build`     | Compile TypeScript → `dist/`          |
| `npm run start`     | Run compiled server (`dist/index.js`) |
| `npm run inspector` | Test with MCP Inspector               |

### Build details

1. `tsc -p tsconfig.build.json` compiles `src/` → `dist/`
2. `src/instructions.md` is copied to `dist/instructions.md` (required asset)
3. Tests are excluded from build via `tsconfig.build.json`

## Testing

| Command                 | Description                              |
| ----------------------- | ---------------------------------------- |
| `npm run test`          | Run all tests (`src/__tests__/**/*.ts`)  |
| `npm run test:watch`    | Run tests in watch mode                  |
| `npm run test:coverage` | Run tests with coverage report           |
| `npm run test:node`     | Run node-tests (isolated Node.js checks) |
| `npm run bench`         | Run benchmarks (`scripts/benchmarks.ts`) |

- **Test runner:** Node.js built-in test runner (`node --test`)
- **Test pattern:** `src/__tests__/**/*.test.ts`
- **Coverage:** `--experimental-test-coverage` flag

## Code Style & Conventions

### Language & compiler

- TypeScript 5.9 with `strict: true`
- Target: ES2022, Module: NodeNext
- All strict options enabled (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.)

### Lint & format

| Command              | Description                   |
| -------------------- | ----------------------------- |
| `npm run lint`       | Run ESLint                    |
| `npm run format`     | Format with Prettier          |
| `npm run type-check` | TypeScript type checking only |

### ESLint rules (key)

- **Unused imports:** error (`eslint-plugin-unused-imports`)
- **Type imports:** `import type { X }` enforced
- **Explicit return types:** required for functions
- **Naming:** camelCase default, PascalCase for types/enums, UPPER_CASE for constants
- **No `any`:** error
- **Async/await:** `@typescript-eslint/require-await`, `no-floating-promises`

### Prettier config

- Single quotes, 2-space indent, LF line endings
- Trailing commas: ES5
- Import sorting via `@trivago/prettier-plugin-sort-imports`
- Import order: Node builtins → MCP SDK → libs → local

### File layout conventions

- One tool per file in `tools/`
- Schemas split: `schemas/inputs/`, `schemas/outputs/`
- Helpers in `lib/` subdirectories (`fs-helpers/`, `file-operations/`)

## Build / Release

- **Build output:** `dist/`
- **Prepublish:** `npm run lint && npm run type-check && npm run build`
- **Release process:**
  1. Create a GitHub release with tag `vX.Y.Z`
  2. CI workflow (`.github/workflows/publish.yml`) triggers
  3. Runs lint → type-check → test → build → npm publish
- **Registry:** npmjs.com (Trusted Publishing via OIDC, no token needed)

## Security & Safety

| Protection                | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| Read-only operations      | No writes, deletes, or modifications                 |
| Path validation           | All paths validated before filesystem access         |
| Allowed directories only  | Explicit roots required (CLI args or MCP Roots)      |
| Symlink protection        | Symlinks that escape allowed roots are blocked       |
| Path traversal prevention | `..` escape attempts detected and blocked            |
| Safe regex (RE2)          | Prevents ReDoS attacks                               |
| Size limits               | Configurable caps prevent resource exhaustion        |
| Binary detection          | `skipBinary=true` default prevents binary file reads |

### Agent safety rules

- **Never** run destructive filesystem commands
- Always use `list_allowed_directories` to verify access scope
- Prefer `read_multiple_files` over looping `read_file`
- Set `maxResults`, `maxDepth`, `maxEntries` limits on searches

## Pull Request / Commit Guidelines

### Required checks before PR

```bash
npm run lint && npm run type-check && npm run build && npm run test
```

### Commit format

- Use clear, descriptive commit messages
- Reference issues where applicable (`Fixes #123`)

### PR workflow

1. Fork → feature branch (`git checkout -b feature/xyz`)
2. Make changes, ensure tests pass
3. Push and open PR against `main`
4. CI runs: lint → type-check → test → build

## Troubleshooting

| Issue                    | Solution                                                             |
| ------------------------ | -------------------------------------------------------------------- |
| "Access denied" error    | Path outside allowed roots. Use `list_allowed_directories` to check. |
| "Path does not exist"    | Verify path with `list_directory`.                                   |
| "File too large"         | Use `head`/`tail` params or increase `maxSize`.                      |
| "Binary file" warning    | Set `skipBinary=false` if intentional.                               |
| No directories available | Pass CLI paths, use `--allow-cwd`, or configure MCP Roots.           |
| Invalid regex/pattern    | Simplify pattern or set `isLiteral=true`.                            |
| Build fails              | Run `npm run clean` then `npm run build`.                            |
| Tests fail after changes | Ensure `src/instructions.md` exists (copied during build).           |

## Agent Operating Rules

- **Search before edit:** Use `search_files` and `search_content` to understand context.
- **Read docs first:** Check `README.md`, `CONFIGURATION.md`, and `src/instructions.md`.
- **Verify paths:** Always use absolute paths; avoid `..` traversal.
- **Prefer batch tools:** `read_multiple_files` and `get_multiple_file_info` for efficiency.
- **Set limits:** Always specify `maxResults`, `maxDepth` on searches to avoid timeouts.
- **No destructive commands:** This is a read-only server—no file modifications.
