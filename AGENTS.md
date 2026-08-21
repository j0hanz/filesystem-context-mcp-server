# filesystem-mcp

MCP server exposing guarded filesystem tools (read, write, search, diff, patch)
over stdio and Streamable HTTP.

## Commands

Run checks through the task runner, not the npm scripts:

```bash
node scripts/tasks.mjs          # format → [lint, type-check, knip] → [test, rebuild]
node scripts/tasks.mjs fix      # auto-fix, then validate
node scripts/tasks.mjs --quick  # static checks only, no tests
node scripts/tasks.mjs detail   # source-window detail for the last test failure
```

`npm run check` exists for CI parity only.

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json` and `server.json` in sync. Never hand-edit either version.
