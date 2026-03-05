# AGENTS.md

MCP Server that enables LLMs to interact with the local filesystem. Provides tools for navigation, search, file management, and analysis — all scoped to allowed directories.

## Tooling

- **Manager**: npm
- **Frameworks**: typescript, eslint, @modelcontextprotocol/sdk, @modelcontextprotocol/sdk, @trivago/prettier-plugin-sort-imports, eslint, eslint-config-prettier, eslint-plugin-de-morgan

## Architecture

- **Runtime entry + transport**: `src/index.ts` parses CLI args (`src/cli.ts`), resolves allowed directories, and starts either stdio transport (`startServer`) or Streamable HTTP transport on `/mcp` (`startHttpServer` in `src/server/bootstrap.ts`).
- **Server composition**: `createServer` builds one `McpServer` per process/session and registers capabilities, prompts, completions, resources, metrics, and all tools.
- **Roots and access control**: `RootsManager` (`src/server/roots-manager.ts`) combines CLI roots, optional CWD, and MCP Roots updates into effective allowed directories; path checks and sensitive-file blocking are enforced in `src/lib/paths.ts`.
- **Tool contract layer**: `src/tools.ts` is the registry for 18 tools. Each tool module defines a `ToolContract`, Zod input/output schemas, and registration wiring.
- **Shared execution pipeline**: `src/tools/shared.ts` centralizes argument validation, typed error mapping, timeout/abort handling, progress reporting, observability hooks, and large-result externalization into `filesystem-mcp://result/{id}` resources.
- **Filesystem operation layer**: reusable primitives in `src/lib/file-operations/*` are consumed by tool handlers (read/write/search/stat/tree/hash/diff/patch).
- **Assistant-facing resources**: `src/resources.ts` exposes `internal://instructions`, `internal://tool-catalog`, `internal://tool-info/{name}`, `internal://workflows`, and `filesystem-mcp://metrics`.

## Testing Strategy

- **Runner and layout**: tests are colocated in `src/__tests__` and run with Node's built-in test runner. `npm run test` builds first via `scripts/tasks.mjs`; `npm run test:fast` runs test files directly with `tsx/esm`.
- **Type-check gate**: `npm run type-check` runs `tsc` against both `tsconfig.json` (src) and `tsconfig.test.json` (tests) concurrently.
- **Isolated integration harness**: `src/__tests__/helpers.ts` creates temp directories, sets allowed roots, wires `McpServer` + `Client` through `InMemoryTransport`, and cleans up state between tests.
- **Contract coverage**: `src/__tests__/contract.test.ts` verifies tool count/names, annotations, and smoke behavior.
- **Security coverage**: `src/__tests__/security.test.ts` verifies boundary enforcement, traversal/symlink escape prevention, and malformed input rejection.
- **Tool behavior coverage**: `src/__tests__/tools/*.test.ts` covers directory ops, file I/O, search/replace, stat/stat_many, and hash/diff behavior.
- **Unit coverage**: `src/__tests__/unit/errors.test.ts` validates error typing and suggestion mapping.
- **CI release gate**: `.github/workflows/release.yml` runs `npm run lint`, `npm run type-check`, `npm run test`, and `npm run build` before tagging/publishing.

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Deploy**: `npm run prepublishOnly`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `git push / force push`, `npm run build`, `npm run test:coverage`, `npm run prepublishOnly`, `git push origin main --follow-tags`, `gh release create "v$VERSION" --title "v$VERSION" --generate-notes`, `npm publish --access public --provenance --ignore-scripts`
- **Never**: Never read or exfiltrate sensitive files like `.mcpregistry_github_token`.; Never edit generated files like `.git` manually.; commit or expose secrets/credentials; edit vendor/generated directories; change production config without approval

## Directory Overview

```text
.
├── .github/            # CI/workflows and repo automation
├── .vscode/
├── assets/             # static assets
├── memory_db/
├── scripts/            # automation scripts
├── src/                # application source
├── .prettierignore     # formatter config
├── .prettierrc         # formatter config
├── docker-compose.yml  # local container orchestration
├── Dockerfile          # container image build
├── eslint.config.mjs   # lint config
├── package.json        # scripts and dependencies
├── README.md           # usage and setup docs
├── server.json         # published server metadata
├── tsconfig.build.json # TypeScript config
└── tsconfig.json       # TypeScript config
└── ...                # 1 more top-level items omitted
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`, `src/server.ts`, `docker-compose.yml`
- **Key Configs**: `.prettierrc`, `tsconfig.json`

## Don'ts

- Don't bypass existing lint/type rules without approval.
- Don't ignore test failures in CI.
- Don't use unapproved third-party packages without checking package manager manifests.
- Don't hardcode secrets or sensitive info in code, tests, docs, or config.
- Don't commit secrets/credentials to the repo.
- Don't edit generated files directly.
- Don't trigger releases without approval.

## Change Checklist

1. Run `npm run lint` to fix lint errors.
2. Run `npm run type-check` to verify types.
3. Run `npm run test` to ensure tests pass.
4. Run `npm run format` to format code.
