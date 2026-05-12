# CLAUDE.md

MCP server exposing filesystem operations to LLM clients over stdio or HTTP.

## Commands

Dev loop is driven by `scripts/tasks.mjs` (alias: `npm run tasks`).

```bash
node scripts/tasks.mjs check          # format → [lint, type-check, knip] → [test, rebuild]
node scripts/tasks.mjs check --quick  # static checks only (skip test + rebuild)
node scripts/tasks.mjs fix            # auto-fix format/lint/knip, then re-validate
node scripts/tasks.mjs test           # run tests directly
node scripts/tasks.mjs test --watch   # watch mode
node scripts/tasks.mjs detail <n>     # show source window for the Nth test failure
```

Useful test flags: `--name-pattern <regex>`, `--timeout <ms>`, `--shard <i/n>`, `--update-snapshots`.

After a failure, `--llm` appends a structured JSON block to stdout and writes `.tasks-last-failure.json`.

**Run a single test file:**

```bash
node --test --import tsx/esm "__tests__/unit/path-guard.test.ts"
```

## Detailed References

- [Architecture](.claude/architecture.md) — request flow, transports, tool system, PathGuard, worker pool, observability, task system
- [Environment Variables](.claude/environment.md) — all `FILESYSTEM_MCP_*` and `FS_*` configuration
- [TypeScript](.claude/typescript.md) — strict tsconfig flags, ESM imports, Zod v4
