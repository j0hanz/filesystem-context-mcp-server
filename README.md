# Filesystem MCP Server

[![License](https://img.shields.io/github/license/j0hanz/filesystem-mcp?style=for-the-badge)](https://github.com/j0hanz/filesystem-mcp/blob/main/LICENSE) [![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffilesystem-mcp?style=for-the-badge&logo=npm&logoColor=white)](https://www.npmjs.com/package/@j0hanz/filesystem-mcp) [![Build](https://img.shields.io/github/actions/workflow/status/j0hanz/filesystem-mcp/release.yml?style=for-the-badge&logo=githubactions&logoColor=white&label=build)](https://github.com/j0hanz/filesystem-mcp/actions) [![GitHub stars](https://img.shields.io/github/stars/j0hanz/filesystem-mcp?style=for-the-badge&logo=github)](https://github.com/j0hanz/filesystem-mcp/stargazers)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22filesystem-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D%7D) [![Install in Cursor](https://img.shields.io/badge/Cursor-Install-000000?style=flat-square&logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

## Overview

Filesystem-MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI assistants read and write files within explicitly allowed directories. Sensitive file patterns (.env, *.pem,*id_rsa\*) are blocked by default. It exposes 12 tools, 3 resources, and 4 prompts over stdio or Streamable HTTP transport.

| Aspect       | Details             |
| :----------- | :------------------ |
| **Status**   | Active — v1.19.1    |
| **Language** | TypeScript (strict) |
| **Runtime**  | Node.js >= 24       |
| **Package**  | npm                 |
| **License**  | MIT                 |

## Features

| Feature                 | Description                                                                                                |
| :---------------------- | :--------------------------------------------------------------------------------------------------------- |
| **Path guarding**       | Every path is validated against allowed roots; `.env`, `*.pem`, `*id_rsa*` and similar patterns are denied |
| **12 filesystem tools** | Navigate, inspect, read, and write across all major file operations                                        |
| **Batch operations**    | Most tools accept `path`, `paths[]`, or `files[]` for parallel execution                                   |
| **Dual transport**      | stdio by default; `--port` enables Streamable HTTP                                                         |
| **File subscriptions**  | Resource subscriptions push change notifications when watched files update                                 |
| **Regex safety**        | RE2 in all search tools: linear-time matching, so no pattern can ReDoS the server                          |

## Built with

[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org) [![Docker](https://img.shields.io/badge/Docker-ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)

| Layer     | Technology                                                             |
| :-------- | :--------------------------------------------------------------------- |
| Protocol  | MCP SDK v2 (`@modelcontextprotocol/server`)                            |
| Runtime   | Node.js >= 24 · TypeScript 6 · ESM                                     |
| Transport | stdio (default) · Streamable HTTP (`--port`)                           |
| Regex     | RE2 (`re2-wasm`) — linear time, no lookahead/lookbehind/backreferences |
| Container | Docker alpine · multi-stage build · non-root user                      |

## Table of Contents

- [Quick start](#quick-start)
- [Usage](#usage)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Quick start

> [!NOTE]
> Requires Node.js ≥ 24.

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

### Configure in VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"]
    }
  }
}
```

Or install via CLI:

```sh
code --add-mcp '{"name":"filesystem","command":"npx","args":["-y","@j0hanz/filesystem-mcp@latest"]}'
```

### Configure in Visual Studio

Add to `.vs\mcp.json` in your solution directory, or `%USERPROFILE%\.mcp.json` for a global configuration:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"]
    }
  }
}
```

### Configure in Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/project"]
    }
  }
}
```

### Install in Cursor

Add to `.cursor/mcp.json` in your project root (project-scoped), or `~/.cursor/mcp.json` for a global configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"]
    }
  }
}
```

### Docker configuration

VS Code (`.vscode/mcp.json`) and Visual Studio (`.vs\mcp.json`):

```json
{
  "servers": {
    "filesystem": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/path/to/project:/workspace",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "/workspace"
      ]
    }
  }
}
```

Claude Desktop (`claude_desktop_config.json`) and Cursor (`mcp.json`):

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
        "/path/to/project:/workspace",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "/workspace"
      ]
    }
  }
}
```

> [!NOTE]
> Add `:ro` to the volume mount (e.g. `/path/to/project:/workspace:ro`) to restrict the server to read-only access. Write tools (`create`, `edit`, `move`, `delete`, `replace_text`) will be unavailable in that mode.

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

| URI                             | Description                                                                           |
| :------------------------------ | :------------------------------------------------------------------------------------ |
| `internal://instructions`       | Server navigation guide — tools overview, constraints, and error recovery.            |
| `filesystem-mcp://file/{+path}` | Read a workspace file. Subscribe to receive push notifications on change.             |
| `filesystem-mcp://result/{id}`  | Ephemeral cached tool output. Expires after ~60 seconds, eviction, or server restart. |

### Prompts

| Prompt                | Description                                                                   |
| :-------------------- | :---------------------------------------------------------------------------- |
| `get-help`            | Return usage instructions, optionally filtered to a specific section.         |
| `analyze-path`        | Workflow for analyzing a file or directory using `stat`, `read`, and `tree`.  |
| `find-in-tree`        | Locate files and content matches by name, content pattern, or both.           |
| `summarize-directory` | Onboarding summary: purpose, tech stack, entry points, and project structure. |

## Project structure

```text
filesystem-mcp/
├── __tests__/        Test suites (unit/, tools/, resources/, schemas/, contract, security, http)
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
| `src/tools/define.ts` | Tool registration and execution framework                    |
| `src/tools/batch.ts`  | Batch helpers (runOverPaths, normalizeBatchItems)            |
| `src/server.ts`       | Wires together all tools, resources, prompts, and transports |

## Configuration

Install it globally once and it works across all your workspaces with no per-project config needed. The server determines which directories are allowed using three methods, tried in this order:

1. **MCP Roots Protocol**: VS Code, Cursor, and Claude Code support the roots capability, so the server queries allowed folders from the client directly.
2. **Environment Variable**: The `FS_ALLOWED_DIRS` environment variable lists fallback directory paths (separated by `:` on POSIX or `;` on Windows).
3. **Current Working Directory**: The `--allow-cwd` flag grants access to the directory where the server started.

### Recommended global recipes

#### VS Code / Cursor / Claude Code (primary recipe)

These clients support the MCP Roots protocol, so no positional arguments are needed. The server queries workspace roots automatically.

Add to your global or project-scoped configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"]
    }
  }
}
```

#### Claude Desktop (fallback recipe via environment variable)

Claude Desktop and similar clients don't support the MCP Roots protocol. Use the `FS_ALLOWED_DIRS` environment variable to configure allowed folders.

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"],
      "env": {
        "FS_ALLOWED_DIRS": "/path/to/project1:/path/to/project2"
      }
    }
  }
}
```

_(On Windows, separate directories with a semicolon `;` instead of a colon `:`)._

### Advanced / per-project positional arguments

You can also restrict access to specific directories by passing positional arguments directly:

```bash
# Start with explicit positional paths
filesystem-mcp /path/to/project1 /path/to/project2
```

---

### Configuration reference

#### CLI flags

| Flag                      | Default | Purpose                                                                            |
| :------------------------ | :------ | :--------------------------------------------------------------------------------- |
| `[dirs...]`               | —       | One or more allowed root directories (positional)                                  |
| `--allow-cwd`             | `false` | Also allow the current working directory as a root                                 |
| `--walk-cwd`              | `false` | Walk up from CWD to find a project root; implies `--allow-cwd`                     |
| `--allow-missing-roots`   | `false` | Start even if configured allowed directories do not exist                          |
| `--port <n>`              | —       | Enable Streamable HTTP transport on the given port                                 |
| `--http-host <host>`      | —       | HTTP server bind address (env: `HTTP_HOST`)                                        |
| `--api-key <key>`         | —       | Require this API key on HTTP requests (env: `API_KEY`)                             |
| `--read-only`             | `false` | Disable write tools: `create`, `edit`, `delete`, `move`, `replace_text`            |
| `--safe`                  | `false` | Alias for `--read-only`                                                            |
| `--deny <pattern>`        | —       | Block paths matching this pattern; repeatable                                      |
| `--allow-sensitive`       | `false` | Allow access to sensitive system paths (env: `ALLOW_SENSITIVE`)                    |
| `--root-boundary <path>`  | —       | Require all allowed roots to fall under this path (env: `ROOT_BOUNDARY`)           |
| `--max-file-size <bytes>` | —       | Maximum file size for reads in bytes (env: `MAX_FILE_SIZE`)                        |
| `--log-level <level>`     | `info`  | Log level: debug, info, warn, or error (env: `LOG_LEVEL`)                          |
| `--print-config`          | `false` | Print the active configuration and exit (use `--json` for machine-readable output) |
| `--json`                  | `false` | Output `--print-config` as JSON                                                    |
| `allow <path>`            | —       | CLI subcommand to authorize a path across client configurations                    |
| `disallow <path>`         | —       | CLI subcommand to de-authorize a path across client configurations                 |
| `list-allowed`            | —       | CLI subcommand to list all currently authorized paths                              |

#### Environment variables

| Variable                                  | Purpose                                                                                                           |
| :---------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| `FS_ALLOWED_DIRS`                         | Colon-separated (POSIX) or semicolon-separated (Windows) list of directories to allow.                            |
| `ROOT_BOUNDARY`                           | Path prefix all allowed roots must fall under (mirrors `--root-boundary`).                                        |
| `ALLOW_CWD_WALK`                          | Set to any value to walk up from CWD to find a project root (mirrors `--walk-cwd`).                               |
| `ALLOW_MISSING_ROOTS`                     | Set to any value to start even if configured directories do not exist.                                            |
| `ALLOW_SENSITIVE`                         | Set to any value to allow access to sensitive system paths (mirrors `--allow-sensitive`).                         |
| `DENYLIST`                                | Comma-separated list of paths or patterns to block (mirrors `--deny`).                                            |
| `MAX_FILE_SIZE`                           | Maximum file size for reads in bytes (mirrors `--max-file-size`).                                                 |
| `LOG_LEVEL`                               | Log level: debug, info, warn, or error (mirrors `--log-level`).                                                   |
| `HTTP_HOST`                               | HTTP server bind address (mirrors `--http-host`).                                                                 |
| `API_KEY`                                 | API key required on HTTP requests (mirrors `--api-key`).                                                          |
| `FILESYSTEM_MCP_TRUST_PROXY`              | Express `trust proxy` setting: hop count or expression. Unset = do not trust `X-Forwarded-*`.                     |
| `FILESYSTEM_MCP_ALLOWED_HOSTS`            | Comma-separated Host header values to accept (HTTP transport).                                                    |
| `FILESYSTEM_MCP_ALLOWED_ORIGINS`          | Comma-separated origin hostnames for CORS.                                                                        |
| `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS` | Set to 1 to bind a wildcard host with no Host validation (accepts the risk).                                      |
| `FILESYSTEM_MCP_PUBLIC_URL`               | Resource identifier URL for RFC 9728 discovery.                                                                   |
| `FILESYSTEM_MCP_MAX_HTTP_SESSIONS`        | Max concurrent HTTP sessions (default 100, 1–10000).                                                              |
| `FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS`  | HTTP session idle timeout in ms (default 1800000, 1000–86400000).                                                 |
| `FILESYSTEM_MCP_RATE_LIMIT_RPM`           | Per-client-IP requests/min on public HTTP bind (default 120, 1–100000).                                           |
| `FS_CONTEXT_MAX_REQUEST_BYTES`            | Max HTTP request body bytes (default 4194304, 1024–268435456).                                                    |
| `FILESYSTEM_MCP_MAX_WATCHERS`             | Max concurrent file watchers (default 256, 1–4096).                                                               |
| `FS_CONTEXT_MAX_INLINE_MATCHES`           | Max inline content matches per search (default 50, 1–10000).                                                      |
| `FS_INIT_HANDSHAKE_TIMEOUT_MS`            | Init handshake timeout in ms (default 30000, 1000–300000).                                                        |
| `FS_INIT_TIMEOUT_CLOSE`                   | Truthy value closes the server on handshake timeout.                                                              |
| `MAX_READ_MANY_TOTAL_SIZE`                | Max total bytes across read_many (default 524288, 10240–104857600).                                               |
| `DEFAULT_SEARCH_TIMEOUT`                  | Search timeout in ms (default 5000, 100–60000).                                                                   |
| `NO_COLOR`                                | Any value disables ANSI color output.                                                                             |
| `FILESYSTEM_MCP_REQUEST_STATE_KEY`        | HMAC key sealing `input_required` requestState across retry rounds (UTF-8, >=32 bytes; random per boot if unset). |

### Examples

```bash
# Allow current working directory
filesystem-mcp --allow-cwd

# HTTP transport on port 3000
filesystem-mcp --port 3000
```

## Scripts

| Mode                | Command                             | Description                                           |
| :------------------ | :---------------------------------- | :---------------------------------------------------- |
| Full check          | `node scripts/tasks.mjs`            | Run build, type check, lint, format, knip, and tests  |
| Auto-fix + check    | `node scripts/tasks.mjs fix`        | Auto-fix linting/formatting issues and run full check |
| Static only         | `node scripts/tasks.mjs --quick`    | Run static analysis without tests                     |
| Tests only          | `node scripts/tasks.mjs test`       | Run all tests                                         |
| Test failure detail | `node scripts/tasks.mjs detail [n]` | Re-run a failed test file with detailed output        |

## Security

> [!IMPORTANT]
> Report vulnerabilities privately via [GitHub Security Advisories](https://github.com/j0hanz/filesystem-mcp/security/advisories). Do not open public issues for security reports.

| Topic           | Detail                                                                          |
| :-------------- | :------------------------------------------------------------------------------ |
| Path traversal  | Every path is resolved and validated against allowed roots before any operation |
| Sensitive files | `.env`, `*.pem`, `*id_rsa*`, and similar patterns are denied by default         |
| Regex safety    | RE2 cannot backtrack, so a hostile pattern cannot hang the server (ReDoS)       |
| Container       | Runs as non-root `mcp` user; bind mounts control what is exposed                |

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/your-feature`.
3. Commit your changes with a clear message.
4. Run `npm run check` to confirm tests, types, lint, and knip all pass.
5. Open a pull request.

[![Contributors](https://contrib.rocks/image?repo=j0hanz/filesystem-mcp)](https://github.com/j0hanz/filesystem-mcp/graphs/contributors)

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.
