# AGENTS.md

## Project Overview

- **Purpose**: Read-only MCP (Model Context Protocol) server for secure filesystem exploration, searching, and analysis
- **Package**: `@j0hanz/filesystem-context-mcp` (npm)
- **Stack**: TypeScript 5.9, Node.js 20+, ESM modules
- **Dependencies**: `@modelcontextprotocol/sdk`, `zod`, `fast-glob`, `re2`, `safe-regex2`

## Repo Map / Structure

```text
src/
  index.ts           # CLI entry point
  server.ts          # MCP server wiring and roots handling
  instructions.md    # Tool usage instructions (bundled in dist)
  config/            # Shared types and formatting helpers
  lib/               # Core logic and filesystem operations
    constants/       # Binary extensions, exclude patterns, MIME types
    file-operations/ # File info, directory listing, glob, read operations
    fs-helpers/      # Abort handling, utilities
    observability/   # Logging/observability utilities
    path-validation/ # Security-focused path validation
  schemas/           # Zod input/output schemas
    inputs/          # Tool input schemas
    outputs/         # Tool output schemas
  server/            # CLI parsing and roots resolution
  tools/             # MCP tool registration and handlers
  __tests__/         # Tests (node:test + tsx)
dist/                # Build output (generated, do not edit)
docs/                # Documentation assets (logo)
node-tests/          # Isolated Node.js checks
scripts/             # Metrics and analysis scripts
```

## Setup & Environment

- **Install deps**: `npm install`
- **Node version**: `>=20.0.0` (required)
- **Package manager**: npm
- **Module system**: ESM (`"type": "module"`)

## Development Workflow

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `npm run dev`       | Watch mode with tsx                   |
| `npm run build`     | Compile TypeScript + copy assets      |
| `npm run start`     | Run compiled server (`dist/index.js`) |
| `npm run inspector` | Test with MCP Inspector               |

### Build details

- Build outputs to `dist/`
- `src/instructions.md` is copied to `dist/instructions.md` during build
- Uses `tsconfig.build.json` (excludes tests)

## Testing

| Command                 | Description                 |
| ----------------------- | --------------------------- |
| `npm run test`          | Run all tests               |
| `npm run test:watch`    | Run tests in watch mode     |
| `npm run test:coverage` | Run tests with coverage     |
| `npm run test:node`     | Run isolated Node.js checks |

- **Test framework**: Node.js native test runner (`node --test`)
- **Test pattern**: `src/__tests__/**/*.test.ts`
- **Isolated tests**: `node-tests/` for Node.js-specific checks

## Code Style & Conventions

| Aspect     | Tool / Config                                |
| ---------- | -------------------------------------------- |
| Language   | TypeScript 5.9, ES2022 target                |
| Lint       | `npm run lint` (ESLint with strict TS rules) |
| Format     | `npm run format` (Prettier)                  |
| Type-check | `npm run type-check`                         |

### Key conventions

- **Strict TypeScript**: `strict: true`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
- **Naming**:
  - Variables/functions: `camelCase`
  - Types/classes: `PascalCase`
  - Constants: `UPPER_CASE` or `camelCase`
- **Imports**: Use type-only imports (`import type { ... }`)
- **Schemas**: Use Zod v4 for all input/output validation
- **Unused imports**: Error (auto-cleaned by ESLint plugin)
- **Explicit return types**: Required for functions

### File layout

- One tool per file in `tools/`
- Schemas in `schemas/inputs/` and `schemas/outputs/`
- Shared logic in `lib/`

## Build / Release

- **Build output**: `dist/`
- **Release trigger**: GitHub release (tag `vX.Y.Z`)
- **CI workflow**: `.github/workflows/publish.yml`
  - Runs: lint → type-check → test → build → publish to npm
  - Uses OIDC trusted publishing (no npm token needed)
- **Versioning**: Semantic versioning via npm
- **prepublishOnly**: `npm run lint && npm run type-check && npm run build`

## Security & Safety

- **Read-only**: No filesystem writes, deletes, or modifications
- **Path validation**: All paths validated before any operation
- **Symlink protection**: Symlinks that escape allowed directories are blocked
- **Path traversal prevention**: `..` escape attempts detected and blocked
- **Safe regex**: RE2 engine prevents ReDoS attacks
- **Size limits**: Configurable limits prevent resource exhaustion
- **Binary detection**: Prevents accidental binary file reads

## Troubleshooting

| Issue                          | Solution                                               |
| ------------------------------ | ------------------------------------------------------ |
| Build fails on instructions.md | Ensure `src/instructions.md` exists                    |
| Type errors in tests           | Use `tsconfig.typecheck.json` (includes test files)    |
| ESLint project errors          | Check `tsconfig.eslint.json` includes the target files |
| Tests timing out               | Check for unclosed handles or increase timeout         |
| "Access denied" at runtime     | Path is outside allowed directories; check CLI args    |
| Invalid regex pattern          | Use `isLiteral=true` or simplify the regex             |

## Agent Operating Rules

1. **Search before edit**: Use `find` and `grep` tools to locate code before modifying
2. **Read context first**: Use `read` or `read_many` to understand existing code
3. **Validate changes**: Run `npm run lint && npm run type-check` after edits
4. **Test changes**: Run `npm run test` before committing
5. **Avoid destructive commands**: This is a read-only server; no file writes in production
6. **Check allowed roots**: Use `roots` tool to verify accessible directories

## Environment Variables (Runtime)

| Variable                 | Default | Description                                   |
| ------------------------ | ------- | --------------------------------------------- |
| `MAX_FILE_SIZE`          | 10MB    | Max file size for read operations (1MB-100MB) |
| `MAX_SEARCH_SIZE`        | 1MB     | Max file size for content search (100KB-10MB) |
| `DEFAULT_SEARCH_TIMEOUT` | 30000   | Timeout for search/list ops (100-3600000ms)   |
