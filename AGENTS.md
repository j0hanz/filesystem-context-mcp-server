# filesystem-mcp

MCP server exposing guarded filesystem tools (read, write, search, diff, patch)
over stdio and Streamable HTTP.

## Commands

Run checks through the task runner, not the npm scripts:

```bash
node scripts/tasks.mjs          # full repository check
node scripts/tasks.mjs fix      # format and lint-fix, then validate
node scripts/tasks.mjs --quick  # static checks only, no tests
node scripts/tasks.mjs test     # Node test runner; accepts native test flags
```

The task runner is a thin cross-platform wrapper over the npm scripts and
Node's built-in test runner.

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json` and `server.json` in sync. Never hand-edit either version.
