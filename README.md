# Filesystem MCP Server

[![License](https://img.shields.io/github/license/j0hanz/filesystem-mcp?style=for-the-badge)](https://github.com/j0hanz/filesystem-mcp/blob/main/LICENSE) [![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffilesystem-mcp?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@j0hanz/filesystem-mcp) [![Build](https://img.shields.io/github/actions/workflow/status/j0hanz/filesystem-mcp/release.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=build)](https://github.com/j0hanz/filesystem-mcp/actions) [![GitHub stars](https://img.shields.io/github/stars/j0hanz/filesystem-mcp?style=for-the-badge&logo=github)](https://github.com/j0hanz/filesystem-mcp/stargazers)

## Overview

filesystem-mcp is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants safe, structured access to a local filesystem. Every operation is confined to explicitly allowed root directories; sensitive paths are blocked by default. It exposes 12 tools, 3 resources, and 4 prompts over stdio or Streamable HTTP transport.

| Aspect       | Details             |
| :----------- | :------------------ |
| **Status**   | Active — v1.19.1    |
| **Language** | TypeScript (strict) |
| **Runtime**  | Node.js >= 24       |
| **Package**  | npm                 |
| **License**  | MIT                 |

## Highlights

| Feature                 | Description                                                                                                |
| :---------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Path guarding**       | Every path is validated against allowed roots; `.env`, `*.pem`, `*id_rsa*` and similar patterns are denied |
| **12 filesystem tools** | Navigate, inspect, read, and write across all major file operations                                        |
| **Batch operations**    | Most tools accept `path`, `paths[]`, or `files[]` for parallel execution                                   |
| **Dual transport**      | stdio by default; `--port` enables Streamable HTTP                                                         |
| **File subscriptions**  | Resource subscriptions push change notifications when watched files update                                 |
| **RE2 regex**           | Safe, non-backtracking regex engine in all search tools                                                    |

## Built With

[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

| Layer     | Technology                                        |
| :-------- | :------------------------------------------------ |
| Protocol  | MCP SDK v2 (`@modelcontextprotocol/server`)       |
| Runtime   | Node.js >= 24 · TypeScript 6 · ESM                |
| Transport | stdio (default) · Streamable HTTP (`--port`)      |
| Regex     | RE2 (non-backtracking, safe for untrusted input)  |
| Container | Docker alpine · multi-stage build · non-root user |

## Quick Start

> [!TIP]
> Get running in under 60 seconds. Requires Node.js ≥ 24.

### Prerequisites

| Requirement | Version / Notes              |
| :---------- | :--------------------------- |
| Node.js     | ≥ 24                         |
| npm         | Bundled with Node.js         |
| Docker      | Optional — for container use |

### Install via npx

```bash
npx -y @j0hanz/filesystem-mcp /path/to/allowed/dir
```

Or install globally:

```bash
npm install -g @j0hanz/filesystem-mcp
filesystem-mcp /path/to/allowed/dir
```

### Install via Docker

```bash
docker run -i --rm \
  -v /path/to/project:/workspace:ro \
  ghcr.io/j0hanz/filesystem-mcp:latest \
  /workspace
```

### Configure in Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp", "/path/to/project"]
    }
  }
}
```

For Docker-based clients:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/path/to/project:/workspace:ro",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "/workspace"
      ]
    }
  }
}
```

## Usage

### Tools

All tools are scoped to the configured roots. Call `list_roots` first to discover what is allowed.

#### Navigate

| Tool         | Description                                                                            |
| :----------- | :------------------------------------------------------------------------------------- |
| `list_roots` | List allowed workspace roots. Call this first — all other tools scope to these.        |
| `list`       | List directory contents. Returns entries (dirs-first, alphabetical) and an ASCII tree. |
| `find_files` | Find files by glob pattern (e.g. `**/*.ts`). Returns matching files with metadata.     |

#### Inspect

| Tool          | Description                                                                               |
| :------------ | :---------------------------------------------------------------------------------------- |
| `stat`        | Get file/directory metadata: size, modified time, permissions, MIME type, token estimate. |
| `search_text` | Search file contents for text (grep-like). Returns matching lines with context.           |
| `hash_file`   | Calculate SHA-256, MD5, or other hashes for a file or directory.                          |

#### Read

| Tool   | Description                                                                                             |
| :----- | :------------------------------------------------------------------------------------------------------ |
| `read` | Read a text file. Supports head/tail, line ranges, and byte-range reads. Accepts `paths[]` for batches. |

#### Write

| Tool           | Description                                                                                       |
| :------------- | :------------------------------------------------------------------------------------------------ |
| `create`       | Create one or more files, overwriting existing content and creating parent directories as needed. |
| `edit`         | Apply sequential literal string replacements to one or more files (max 5 per call).               |
| `move`         | Move or rename one or more files/directories to explicit destinations.                            |
| `delete`       | Permanently delete one or more files or directories. This action is irreversible.                 |
| `replace_text` | Bulk search-and-replace across files matching a glob pattern.                                     |

### Resources

| URI                             | Description                                                                |
| :------------------------------ | :------------------------------------------------------------------------- |
| `internal://instructions`       | Server navigation guide — tools overview, constraints, and error recovery. |
| `filesystem-mcp://file/{+path}` | Read a workspace file. Subscribe to receive push notifications on change.  |
| `filesystem-mcp://result/{id}`  | Ephemeral cached tool output. Expires after 30 minutes or server restart.  |

### Prompts

| Prompt                | Description                                                                   |
| :-------------------- | :---------------------------------------------------------------------------- |
| `get-help`            | Return usage instructions, optionally filtered to a specific section.         |
| `analyze-path`        | Workflow for analyzing a file or directory using `stat`, `read`, and `tree`.  |
| `find-in-tree`        | Locate files and content matches by name, content pattern, or both.           |
| `summarize-directory` | Onboarding summary: purpose, tech stack, entry points, and project structure. |

## Project Structure

```text
filesystem-mcp/
├── __tests__/        Test suites (integration, unit, contract, security)
├── assets/           Server logo (embedded in protocol responses)
├── scripts/          Build and task utilities
├── src/
│   ├── core/         Path guarding, filesystem abstraction, concurrency, observability
│   ├── tools/        12 tool definitions (one file per tool)
│   ├── server.ts     Server factory and registration of all tools/resources/prompts
│   ├── transport.ts  stdio and Streamable HTTP transport setup
│   ├── prompts.ts    4 built-in prompt definitions
│   └── resources.ts  3 built-in resource definitions
└── Dockerfile        Multi-stage alpine build, non-root user
```

| Path                  | Purpose                                                      |
| :-------------------- | :----------------------------------------------------------- |
| `src/core/path.ts`    | `PathGuard` — validates every path against allowed roots     |
| `src/core/fs.ts`      | `GuardedFileSystem` — all filesystem I/O flows through this  |
| `src/tools/define.ts` | Tool registration, execution framework, and batch helpers    |
| `src/server.ts`       | Wires together all tools, resources, prompts, and transports |

## Configuration

All configuration is provided as CLI flags at startup. There are no environment variables.

### CLI Flags

| Flag          | Default | Purpose                                            |
| :------------ | :------ | :------------------------------------------------- |
| `[dirs...]`   | —       | One or more allowed root directories               |
| `--allow-cwd` | `false` | Also allow the current working directory as a root |
| `--port <n>`  | —       | Enable Streamable HTTP transport on the given port |

### Examples

```bash
# Single root
filesystem-mcp /path/to/project

# Multiple roots
filesystem-mcp /project/src /project/docs

# Allow current working directory
filesystem-mcp --allow-cwd

# HTTP transport on port 3000
filesystem-mcp --port 3000 /path/to/project
```

## Scripts

| Command              | Description                                         |
| :------------------- | :-------------------------------------------------- |
| `npm run build`      | Compile TypeScript to `dist/`                       |
| `npm test`           | Run all tests with the Node.js built-in test runner |
| `npm run lint`       | Run ESLint (zero warnings enforced)                 |
| `npm run format`     | Format source with Prettier                         |
| `npm run type-check` | TypeScript type check without emit                  |
| `npm run knip`       | Check for unused exports and dependencies           |
| `npm run check`      | Full static analysis + tests                        |

## Security

> [!IMPORTANT]
> Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/j0hanz/filesystem-mcp/security/advisories). Do not open public issues for security reports.

| Topic           | Detail                                                                          |
| :-------------- | :------------------------------------------------------------------------------ |
| Path traversal  | Every path is resolved and validated against allowed roots before any operation |
| Sensitive files | `.env`, `*.pem`, `*id_rsa*`, and similar patterns are denied by default         |
| Regex safety    | RE2 engine prevents catastrophic backtracking on untrusted search patterns      |
| Container       | Runs as non-root `mcp` user; bind mounts control what is exposed                |

## Contributing

1. Fork the repository.
2. Create a feature branch — `git checkout -b feat/your-feature`.
3. Commit your changes with a clear message.
4. Run `npm run check` to confirm tests, types, lint, and knip all pass.
5. Open a pull request.

[![Contributors](https://contrib.rocks/image?repo=j0hanz/filesystem-mcp)](https://github.com/j0hanz/filesystem-mcp/graphs/contributors)

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.
