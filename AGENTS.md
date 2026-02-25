# AGENTS.md

MCP server for local filesystem access by LLM clients, built with TypeScript and Docker/GitHub Actions infrastructure.

## Tooling

- **Manager**: npm
- **Frameworks**: TypeScript, Zod v4, @modelcontextprotocol/sdk, ESLint, Prettier

## Commands

- **Dev**: `npm run dev`
- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Deploy**: N/A

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test`
- **Ask First**: `npm run test:coverage`, `npm run build`, release/publish workflow, Docker/infrastructure changes, deleting files
- **Never**: commit or expose credentials; edit generated/vendor directories (`dist/`, `node_modules/`); commit sensitive token files (`.mcpregistry_github_token`, `.mcpregistry_registry_token`)

## Directory Overview

```text
.
├── src/                 # MCP server source (tools, schemas, runtime)
├── node-tests/          # Node-level test cases
├── scripts/             # Build/test task orchestrators
├── assets/              # Static assets
├── memory_db/           # Local memory storage artifacts
├── .github/             # Workflows and repository automation
├── package.json         # Scripts and dependencies
├── server.json          # Published server metadata
└── README.md            # Usage and integration docs
```

## Navigation

- **Entry Points**: `src/index.ts`, `src/server.ts`, `package.json`, `README.md`, `docker-compose.yml`
- **Key Configs**: TypeScript (`tsconfig*.json`), ESLint (`eslint.config.mjs`), Prettier (`.prettierrc`), Git (`.gitignore`)

## Don'ts

- Don't bypass lint/type-check rules without approval.
- Don't ignore failing test results.
- Don't add unapproved third-party packages without checking `package.json` impact.
- Don't hardcode secrets or credentials in code, tests, docs, or config.
- Don't commit or share `.mcpregistry_github_token` or `.mcpregistry_registry_token`.
- Don't edit generated output in `dist/` or dependencies in `node_modules/`.
- Don't run release/publish steps (`npm publish`, tag/release automation) without explicit approval.

## Change Checklist

1. Run `npm run lint`.
2. Run `npm run type-check`.
3. Run `npm run test`.
4. Run `npm run build` when touching runtime/server behavior.
5. Update `README.md` or `server.json` when public behavior/metadata changes.
