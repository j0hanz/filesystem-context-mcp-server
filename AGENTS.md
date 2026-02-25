# AGENTS.md

A TypeScript-based Model Context Protocol (MCP) server for secure local filesystem operations, built with Node.js (>=24), the MCP SDK, and Zod v4.

## Tooling

- **Manager**: npm
- **Frameworks**: TypeScript 5.9+, Node.js (>=24), @modelcontextprotocol/sdk ^1.26, Zod ^4.3
- **Infra**: Docker, GitHub Actions (release workflow)

## Commands

- **Dev**: `npm run dev` (watch mode) or `npm run dev:run`
- **Test**: `npm run test` or `npm run test:fast`
- **Lint**: `npm run lint`
- **Format**: `npm run format`
- **Type Check**: `npm run type-check`
- **Build**: `npm run build`
- **Dead Code**: `npm run knip`

## Safety Boundaries

- **Always**: Run `npm run test:fast`, `npm run lint`, and `npm run type-check` to verify changes.
- **Ask First**: Installing dependencies, deleting files, running full builds (`npm run build`), generating coverage (`npm run test:coverage`), or deploying/releasing.
- **Never**: Commit or expose secrets (e.g., `.mcpregistry_github_token`, `.mcpregistry_registry_token`), or edit generated directories (`dist/`).

## Navigation

- **Entry Points**: `src/index.ts` (shebang/transport), `src/server.ts` (McpServer instance), `src/cli.ts` (CLI)
- **Tool Files**: `src/tools.ts` (registry), `src/tools/*.ts` (one tool per file)
- **Schemas**: `src/schemas.ts` (input/output Zod schemas)
- **Key Configs**: `tsconfig.json`, `eslint.config.mjs`, `docker-compose.yml`, `Dockerfile`, `server.json`, `knip.json`

## Change Checklist

1. Run `npm run type-check` to ensure type safety.
2. Run `npm run lint` to maintain code style.
3. Run `npm run test:fast` to verify functionality.
