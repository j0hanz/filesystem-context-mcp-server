# Agent Instructions

## Project

- Secure filesystem MCP server for reading, writing, searching, diffing, and patching files.
- TypeScript + Node (MCP SDK v2, ESM)

## Hard Rules

- Conventional Commits format (`type(scope): subject`) required (see `pr-workflow` skill)
- Breaking changes are fine. Never add fallback/legacy-compat shims; rewrite to the better approach directly
- Test/typecheck only files you changed; do not require full-suite runs
- Automated CI runs on GitHub Actions

## Package Manager

- npm

### Common Commands

| Mode                | Command                             |
| ------------------- | ----------------------------------- |
| Full check          | `node scripts/tasks.mjs`            |
| Auto-fix + check    | `node scripts/tasks.mjs fix`        |
| Static only         | `node scripts/tasks.mjs --quick`    |
| Tests only          | `node scripts/tasks.mjs test`       |
| Test failure detail | `node scripts/tasks.mjs detail [n]` |

<!-- project-init:hard-rules v1 commit=strict maturity=development testing=touched-files ci=github-actions sections=conventions,dependencies,file-commands -->
