# AGENTS.md

A local filesystem MCP server that lets LLMs and AI agents read, write, search, diff, patch, and manage files safely and efficiently. Built for reliable, structured, and controlled filesystem interaction.

## Tooling

- **Manager**: npm
- **Frameworks**: TypeScript, ESLint, `@modelcontextprotocol/sdk`, Zod

## Architecture

- Tool-based

## Testing Strategy

- Colocated test directories (`src/__tests__/`), 22 test files found

## Commands

- **Test**: `npm run test`
- **Lint**: `npm run lint`
- **Type Check**: `npm run type-check`
- **Format**: `npm run format`
- **Build**: `npm run build`

## Safety Boundaries

- **Always**: `npm run lint`, `npm run type-check`, `npm run test` and `npm run build`.
- **Ask First**: `installing dependencies`, `deleting files`, `running full builds or e2e suites`, `database/schema migrations`, `deploy or infrastructure changes`, `npm run build`, `npm run test:coverage`
- **Never**: run `git commit`, `git push`, `git push --force`, `git tag`, `gh release create`, `npm publish`, `npm run prepublishOnly`, or any release/publish/deploy command; commit or expose secrets/credentials; read or exfiltrate `.mcpregistry_github_token` or `.mcpregistry_registry_token`; edit generated/vendor directories like `.git`, `.tmp`, `dist`, or `node_modules`; change production config without approval

## Directory Overview

```text
.
├── .github/            # CI/workflows and release automation
├── assets/             # static assets
├── dist/               # built output
├── scripts/            # repo automation scripts
├── src/                # server, tools, resources, and tests
├── Dockerfile          # container build
├── docker-compose.yml  # local container orchestration
├── eslint.config.mjs   # lint config
├── package.json        # scripts and dependencies
├── README.md           # usage and setup docs
├── server.json         # published server metadata
└── tsconfig.json       # TypeScript config
```

## Navigation

- **Entry Points**: `package.json`, `README.md`, `src/index.ts`, `src/server.ts`, `docker-compose.yml`
- **Key Configs**: `.prettierrc`, `tsconfig.json`

## Don'ts

- Don't commit secrets/credentials to the repo.
- Don't read or exfiltrate registry token files.
- Don't edit generated/vendor directories directly.
- Don't change production config or trigger release/publish flows without approval.
- Don't run commands that affect git history or releases without approval.

## Change Checklist

1. Run `npm run lint` to fix lint errors.
2. Run `npm run type-check` to verify types.
3. Run `npm run test` to ensure tests pass.
4. Run `npm run format` to format code.
5. Run `npm run build` to build the project.
6. Update `README.md` if relevant.
