# Filesystem MCP Server

[![npm version](https://img.shields.io/npm/v/%40j0hanz%2Ffilesystem-mcp?style=flat-square&logo=npm)](https://www.npmjs.com/package/%40j0hanz%2Ffilesystem-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#contributing-and-license)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders) [![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install_Server-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22filesystem-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D%7D)

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

A local filesystem MCP server that lets LLMs and AI agents read, write, search, diff, patch, and manage files safely and efficiently. Built for reliable, structured, and controlled filesystem interaction.

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Quick Start](#quick-start) — [Docker](#docker) · [CLI Usage](#cli-usage)
- [Client Configuration](#client-configuration)
- [Use Cases](#use-cases)
- [Architecture](#architecture)
- [MCP Surface](#mcp-surface) — [Tools](#tools) · [Resources](#resources) · [Prompts](#prompts)
- [MCP Capabilities](#mcp-capabilities) — [Tool Annotations](#tool-annotations) · [Structured Output](#structured-output)
- [Configuration](#configuration) — [HTTP & Auth](#http--auth) · [File Size Limits](#file-size-limits) · [Access Control](#access-control) · [Output & Inline Limits](#output--inline-limits) · [Tasks](#tasks) · [Logging & Diagnostics](#logging--diagnostics) · [Performance](#performance)
- [HTTP Endpoints](#http-endpoints)
- [Security](#security)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)
- [Contributing and License](#contributing-and-license)

## Overview

A secure, production-ready [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants controlled access to the local filesystem. All operations are sandboxed to explicitly allowed directories with path traversal prevention, sensitive file blocking, and optional Bearer token authentication.

Supports stdio (default) and Node Streamable HTTP transport. HTTP sessions are implemented with isolated per-session server state.

## Key Features

- **18 filesystem tools** — read, write, search, diff, patch, hash, and bulk operations with structured output schemas
- **Security-first** — path validation, symlink escape prevention, sensitive file denylist, localhost-only CORS, optional API key auth
- **Dual transport** — stdio for local use, Node Streamable HTTP for networked/multi-session deployments
- **Structured output** — all tools return typed `outputSchema` / `structuredContent` for reliable LLM parsing
- **Self-documenting** — 6 built-in resources (`internal://instructions`, `internal://tool-catalog`, etc.) and 4 built-in prompts (`get-help`, `compare-files`, `analyze-path`, `get-tool-help`)

## Requirements

- Node.js >= 24

## Quick Start

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

### Docker

```bash
docker run -i --rm -v /path/to/project:/workspace:ro ghcr.io/j0hanz/filesystem-mcp /workspace
```

Or using Docker Compose:

```yaml
services:
  filesystem-mcp:
    build: .
    stdin_open: true
    volumes:
      - ./:/projects/workspace:ro
    command: ['/projects/workspace']
```

### CLI Usage

```
filesystem-mcp [options] [allowedDirs...]

Arguments:
  allowedDirs              Directories the server can access

Options:
  --allow-cwd              Allow the current working directory as an additional root
  --port <number>          Enable HTTP transport on the given port
  -v, --version            Display server version
  -h, --help               Display help

Examples:
  $ npx @j0hanz/filesystem-mcp@latest /path/to/project
  $ npx @j0hanz/filesystem-mcp@latest --allow-cwd
  $ npx @j0hanz/filesystem-mcp@latest --port 3000 /path/to/project
```

## Client Configuration

<details>
<summary><b>Install in VS Code</b></summary>

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D)

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

</details>

<details>
<summary><b>Install in VS Code Insiders</b></summary>

[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders)

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
code-insiders --add-mcp '{"name":"filesystem","command":"npx","args":["-y","@j0hanz/filesystem-mcp@latest"]}'
```

</details>

<details>
<summary><b>Install in Cursor</b></summary>

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

Add to `~/.cursor/mcp.json`:

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

</details>

<details>
<summary><b>Install in Visual Studio</b></summary>

[![Install in Visual Studio](https://img.shields.io/badge/Visual_Studio-Install_Server-C16FDE?logo=visualstudio&logoColor=white)](https://vs-open.link/mcp-install?%7B%22filesystem-mcp%22%3A%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D%7D)

Add to `<SOLUTIONDIR>.mcp.json` or `%USERPROFILE%\.mcp.json`:

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

</details>

<details>
<summary><b>Install in Goose</b></summary>

Add to `~/.config/goose/config.yaml`:

```yaml
extensions:
  filesystem:
    name: Filesystem MCP
    cmd: npx
    args:
      - -y
      - '@j0hanz/filesystem-mcp@latest'
    enabled: true
    type: stdio
```

</details>

<details>
<summary><b>Add to LM Studio</b></summary>

[![Add to LM Studio](https://files.lmstudio.ai/deeplink/mcp-install-light.svg)](https://lmstudio.ai/install-mcp?name=filesystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

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

</details>

<details>
<summary><b>Install in Claude Desktop</b></summary>

Add to `claude_desktop_config.json`:

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

</details>

<details>
<summary><b>Install in Claude Code</b></summary>

```sh
claude mcp add filesystem-mcp -- npx -y @j0hanz/filesystem-mcp@latest
```

Or add a project-scoped `.mcp.json`:

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

</details>

<details>
<summary><b>Install in Windsurf</b></summary>

Add to `~/.codeium/windsurf/mcp_config.json`:

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

</details>

<details>
<summary><b>Install in Amp</b></summary>

```sh
amp mcp add filesystem-mcp -- npx -y @j0hanz/filesystem-mcp@latest
```

Or add to `settings.json`:

```json
{
  "amp.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"]
    }
  }
}
```

</details>

<details>
<summary><b>Install in Cline</b></summary>

Add to `cline_mcp_settings.json`:

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

</details>

<details>
<summary><b>Install in Codex</b></summary>

```sh
codex mcp add filesystem -- npx -y @j0hanz/filesystem-mcp@latest
```

Or add to `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@j0hanz/filesystem-mcp@latest"]
```

</details>

<details>
<summary><b>Install in GitHub Copilot Coding Agent</b></summary>

Add this JSON in your repository's GitHub Copilot coding agent MCP configuration:

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"],
      "tools": ["*"]
    }
  }
}
```

</details>

<details>
<summary><b>Install in Warp</b></summary>

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

</details>

<details>
<summary><b>Install in Kiro</b></summary>

Add to `.kiro/settings/mcp.json`:

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

</details>

<details>
<summary><b>Install in Gemini CLI</b></summary>

Add to `~/.gemini/settings.json`:

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

</details>

<details>
<summary><b>Install in Zed</b></summary>

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest"],
      "env": {}
    }
  }
}
```

</details>

<details>
<summary><b>Install in Augment</b></summary>

Add to VS Code `settings.json` under `augment.advanced`:

```json
{
  "augment.advanced": {
    "mcpServers": [
      {
        "id": "filesystem",
        "command": "npx",
        "args": ["-y", "@j0hanz/filesystem-mcp@latest"]
      }
    ]
  }
}
```

</details>

<details>
<summary><b>Install in Roo Code</b></summary>

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

</details>

<details>
<summary><b>Install in Kilo Code</b></summary>

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

</details>

[↑ Back to top](#table-of-contents)

## Use Cases

### Explore and Understand a Codebase

Discover project structure and navigate unfamiliar repositories. Start with `roots` to see allowed directories, use `tree` for an overview, `find` to locate files by pattern, and `read` or `read_many` to inspect contents.

**Relevant tools:** [`roots`](#roots), [`ls`](#ls), [`find`](#find), [`tree`](#tree), [`read`](#read), [`read_many`](#read_many), [`stat`](#stat)

### Search Across Files

Locate specific code patterns, function definitions, or configuration values across a project. Use `grep` for content search with regex support and `find` for file name matching.

**Relevant tools:** [`grep`](#grep), [`find`](#find)

### Edit and Refactor Code

Make precise, targeted edits to source files. Use `edit` for surgical replacements with dry-run preview, or `search_and_replace` for bulk changes across multiple files matching a glob pattern.

**Relevant tools:** [`edit`](#edit), [`search_and_replace`](#search_and_replace), [`write`](#write)

### Diff and Patch Workflow

Compare file versions and apply patches. Generate a unified diff with `diff_files`, preview with `apply_patch(dryRun: true)`, then apply. Supports both single-file and multi-file patches (best-effort per file with per-file `results[]`).

**Relevant tools:** [`diff_files`](#diff_files), [`apply_patch`](#apply_patch)

### File Management

Create directories, move/rename files, delete files, and verify file integrity via SHA-256 hashing.

**Relevant tools:** [`mkdir`](#mkdir), [`mv`](#mv), [`rm`](#rm), [`calculate_hash`](#calculate_hash), [`write`](#write)

## Architecture

```text
[MCP Client]
    |
    | Transport: stdio (default) or Node Streamable HTTP (--port)
    v
[MCP Server: filesystem-mcp]
    | Entry: src/index.ts -> src/server/bootstrap.ts
    |
    +-- initialize / initialized
    |
    +-- tools/call ──────────────────────────────────────────
    |   +-- [roots]             — List allowed workspace roots
    |   +-- [ls]                — List directory contents
    |   +-- [find]              — Find files by glob
    |   +-- [tree]              — Render directory tree
    |   +-- [read]              — Read file contents
    |   +-- [read_many]         — Read multiple files
    |   +-- [stat]              — Get file metadata
    |   +-- [stat_many]         — Get multiple file metadata
    |   +-- [grep]              — Search file contents
    |   +-- [mkdir]             — Create directory
    |   +-- [write]             — Write file
    |   +-- [edit]              — Edit file (string replacements)
    |   +-- [mv]                — Move/rename file
    |   +-- [rm]                — Delete file
    |   +-- [calculate_hash]    — SHA-256 hash
    |   +-- [diff_files]        — Unified diff
    |   +-- [apply_patch]       — Apply unified patch
    |   +-- [search_and_replace]— Bulk search & replace
    |
    +-- resources/read ──────────────────────────────────────
    |   +-- internal://instructions
    |   +-- internal://tool-catalog
    |   +-- internal://workflows
    |   +-- internal://tool-info/{name}
    |   +-- filesystem-mcp://result/{id}
    |   +-- filesystem-mcp://metrics
    |
    +-- prompts/get ─────────────────────────────────────────
    |   +-- get-help (optional topic argument)
    |   +-- compare-files (original, modified)
    |   +-- analyze-path (path)
    |   +-- get-tool-help (name)
    |
    +-- Capabilities: logging, resources, tools, prompts, completions, tasks
```

### Request Lifecycle

```text
[Client] -- initialize {protocolVersion, capabilities} --> [Server]
[Server] -- {protocolVersion, capabilities, serverInfo} --> [Client]
[Client] -- notifications/initialized --> [Server]
[Client] -- tools/call {name, arguments} --> [Server]
[Server] -- validate(inputSchema) --> [Handler]
[Handler] -- {content: [{type, text}], structuredContent?, isError?} --> [Client]
```

## MCP Surface

### Tools

[`roots`](#roots) · [`ls`](#ls) · [`find`](#find) · [`tree`](#tree) · [`read`](#read) · [`read_many`](#read_many) · [`stat`](#stat) · [`stat_many`](#stat_many) · [`grep`](#grep) · [`mkdir`](#mkdir) · [`write`](#write) · [`edit`](#edit) · [`mv`](#mv) · [`rm`](#rm) · [`calculate_hash`](#calculate_hash) · [`diff_files`](#diff_files) · [`apply_patch`](#apply_patch) · [`search_and_replace`](#search_and_replace)

#### `roots`

List allowed workspace roots. Call first — all other tools are scoped to these directories.

_No parameters._

---

#### `ls`

List immediate directory contents: name, path, type, size, modified date.

| Parameter               | Type    | Required | Description                                                                 |
| ----------------------- | ------- | -------- | --------------------------------------------------------------------------- |
| `path`                  | string  | no       | Base directory (default: root)                                              |
| `includeHidden`         | boolean | no       | Include dotfiles. Default: `false`                                          |
| `includeIgnored`        | boolean | no       | Include ignored items (node_modules, .git). Default: `false`                |
| `maxDepth`              | integer | no       | Max recursion depth (1-50) when pattern is provided                         |
| `maxEntries`            | integer | no       | Max entries before truncation. Default: 20000, Max: 20000                   |
| `sortBy`                | enum    | no       | `name` \| `size` \| `modified` \| `type`. Default: `name`                   |
| `pattern`               | string  | no       | Relative glob filter (e.g. `**/*.ts`). Absolute paths and `..` are rejected |
| `includeSymlinkTargets` | boolean | no       | Resolve symlink targets. Default: `false`                                   |
| `cursor`                | string  | no       | Pagination cursor from a previous response                                  |

---

#### `find`

Find files by glob pattern. Returns matching files with metadata.

| Parameter        | Type    | Required | Description                                                                  |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `path`           | string  | no       | Base directory (default: root)                                               |
| `pattern`        | string  | **yes**  | Relative glob pattern (e.g. `**/*.ts`). Absolute paths and `..` are rejected |
| `maxResults`     | integer | no       | Max results (1-10000). Default: 100                                          |
| `includeIgnored` | boolean | no       | Include ignored items. Default: `false`                                      |
| `includeHidden`  | boolean | no       | Include dotfiles. Default: `false`                                           |
| `sortBy`         | enum    | no       | `path` \| `name` \| `size` \| `modified`. Default: `path`                    |
| `maxDepth`       | integer | no       | Max directory depth (0-100)                                                  |
| `cursor`         | string  | no       | Pagination cursor                                                            |

---

#### `tree`

Render a directory tree with bounded recursion. Returns ASCII tree + structured JSON.

| Parameter        | Type    | Required | Description                                          |
| ---------------- | ------- | -------- | ---------------------------------------------------- |
| `path`           | string  | no       | Base directory (default: root)                       |
| `maxDepth`       | integer | no       | Depth (0 = root node only). Default: 5, Max: 50      |
| `maxEntries`     | integer | no       | Max entries. Default: 1000, Max: 20000               |
| `includeHidden`  | boolean | no       | Include dotfiles. Default: `false`                   |
| `includeIgnored` | boolean | no       | Include ignored items. Default: `false`              |
| `includeSizes`   | boolean | no       | Include file sizes in tree entries. Default: `false` |

---

#### `read`

Read text file contents. Use `head`/`tail` to preview first/last N lines of large files.

| Parameter     | Type    | Required | Description                                                 |
| ------------- | ------- | -------- | ----------------------------------------------------------- |
| `path`        | string  | **yes**  | Absolute path to file                                       |
| `head`        | integer | no       | Read first N lines (1-100000)                               |
| `tail`        | integer | no       | Read last N lines (1-100000)                                |
| `startLine`   | integer | no       | Start line (1-based, inclusive)                             |
| `endLine`     | integer | no       | End line (1-based, inclusive). Requires `startLine`         |
| `includeHash` | boolean | no       | Include SHA-256 hash of full file content. Default: `false` |

---

#### `read_many`

Read multiple text files in one request.

| Parameter   | Type     | Required | Description                     |
| ----------- | -------- | -------- | ------------------------------- |
| `paths`     | string[] | **yes**  | Files to read (1-100 paths)     |
| `head`      | integer  | no       | Read first N lines of each file |
| `tail`      | integer  | no       | Read last N lines of each file  |
| `startLine` | integer  | no       | Start line (1-based) per file   |
| `endLine`   | integer  | no       | End line (1-based) per file     |

---

#### `stat`

Get file/directory metadata: size, modified, permissions, mime, tokenEstimate.

| Parameter | Type   | Required | Description                        |
| --------- | ------ | -------- | ---------------------------------- |
| `path`    | string | **yes**  | Absolute path to file or directory |

---

#### `stat_many`

Get metadata for multiple files/directories in one request.

| Parameter | Type     | Required | Description                  |
| --------- | -------- | -------- | ---------------------------- |
| `paths`   | string[] | **yes**  | File/directory paths (1-100) |

---

#### `grep`

Search file contents (grep-like). Returns matching lines with optional context.

| Parameter        | Type    | Required | Description                                                         |
| ---------------- | ------- | -------- | ------------------------------------------------------------------- |
| `path`           | string  | no       | Base directory (default: root)                                      |
| `pattern`        | string  | **yes**  | Search text or RE2 regex when `isRegex=true`                        |
| `isRegex`        | boolean | no       | Treat pattern as RE2 regex. Default: `false`                        |
| `caseSensitive`  | boolean | no       | Case-sensitive matching. Default: `false`                           |
| `wholeWord`      | boolean | no       | Match whole words only. Default: `false`                            |
| `contextLines`   | integer | no       | Lines of context before/after (0-50). Default: 0                    |
| `maxResults`     | integer | no       | Max match rows (0-10000). Default: 500                              |
| `filePattern`    | string  | no       | Relative glob for candidate files (e.g. `**/*.ts`). Default: `**/*` |
| `includeHidden`  | boolean | no       | Include dotfiles. Default: `false`                                  |
| `includeIgnored` | boolean | no       | Include ignored items. Default: `false`                             |

---

#### `mkdir`

Create a new directory (recursive). Idempotent.

| Parameter | Type     | Required | Description                                                       |
| --------- | -------- | -------- | ----------------------------------------------------------------- |
| `path`    | string   | no       | Absolute path to directory to create                              |
| `paths`   | string[] | no       | Multiple directories to create. Either `path` or `paths` required |

---

#### `write`

Write content to a file, **overwriting all existing content**. Creates parent directories if needed.

| Parameter | Type   | Required | Description           |
| --------- | ------ | -------- | --------------------- |
| `path`    | string | **yes**  | Absolute path to file |
| `content` | string | **yes**  | Content to write      |

---

#### `edit`

Apply sequential literal string replacements (first occurrence per edit). Use `dryRun` to preview.

| Parameter          | Type    | Required | Description                                                |
| ------------------ | ------- | -------- | ---------------------------------------------------------- |
| `path`             | string  | **yes**  | Absolute path to file                                      |
| `edits`            | array   | **yes**  | List of non-empty `{oldText, newText}` replacements        |
| `dryRun`           | boolean | no       | Preview edits without writing. Default: `false`            |
| `ignoreWhitespace` | boolean | no       | Treat whitespace sequences as equivalent. Default: `false` |

---

#### `mv`

Move or rename a file or directory.

| Parameter     | Type     | Required | Description                                          |
| ------------- | -------- | -------- | ---------------------------------------------------- |
| `source`      | string   | no       | Single path to move (deprecated: use `sources`)      |
| `sources`     | string[] | no       | Paths to move. Either `source` or `sources` required |
| `destination` | string   | **yes**  | Destination path                                     |

---

#### `rm`

Permanently delete a file or directory. **Irreversible.**

| Parameter           | Type    | Required | Description                                    |
| ------------------- | ------- | -------- | ---------------------------------------------- |
| `path`              | string  | **yes**  | Absolute path to file or directory             |
| `recursive`         | boolean | no       | Delete non-empty directories. Default: `false` |
| `ignoreIfNotExists` | boolean | no       | No error if missing. Default: `false`          |

---

#### `calculate_hash`

Calculate SHA-256 hash of a file or directory.

| Parameter | Type   | Required | Description                        |
| --------- | ------ | -------- | ---------------------------------- |
| `path`    | string | **yes**  | Absolute path to file or directory |

---

#### `diff_files`

Generate a unified diff between two files. Output feeds directly into `apply_patch`.

| Parameter          | Type    | Required | Description                                          |
| ------------------ | ------- | -------- | ---------------------------------------------------- |
| `original`         | string  | **yes**  | Path to original file                                |
| `modified`         | string  | **yes**  | Path to modified file                                |
| `context`          | integer | no       | Lines of context in diff output                      |
| `ignoreWhitespace` | boolean | no       | Ignore leading/trailing whitespace. Default: `false` |
| `stripTrailingCr`  | boolean | no       | Strip trailing carriage returns. Default: `false`    |

---

#### `apply_patch`

Apply a unified diff patch to one or more files. Single-file: throws on failure. Multi-file: best-effort per file with `results[]`. Workflow: `diff_files` -> `apply_patch(dryRun)` -> `apply_patch`.

| Parameter                | Type    | Required | Description                                                |
| ------------------------ | ------- | -------- | ---------------------------------------------------------- |
| `path`                   | string  | **yes**  | Path to file (single) or base directory (multi-file patch) |
| `patch`                  | string  | **yes**  | Unified diff with `@@` hunk headers (single or multi-file) |
| `fuzzFactor`             | integer | no       | Max fuzzy mismatches per hunk (0-20)                       |
| `autoConvertLineEndings` | boolean | no       | Auto-convert line endings. Default: `true`                 |
| `dryRun`                 | boolean | no       | Validate without writing. Default: `false`                 |

---

#### `search_and_replace`

Bulk search-and-replace across files matching a glob. Replaces **all** occurrences per file. Always `dryRun: true` first.

| Parameter        | Type    | Required | Description                                             |
| ---------------- | ------- | -------- | ------------------------------------------------------- |
| `path`           | string  | no       | Base directory (default: root)                          |
| `filePattern`    | string  | no       | Relative glob pattern (e.g. `**/*.ts`). Default: `**/*` |
| `searchPattern`  | string  | **yes**  | Text to search. RE2 regex when `isRegex=true`           |
| `replacement`    | string  | **yes**  | Replacement text. Supports `$1`, `$2` with regex        |
| `isRegex`        | boolean | no       | Treat as RE2 regex. Default: `false`                    |
| `dryRun`         | boolean | no       | Preview matches with diff. Default: `false`             |
| `includeHidden`  | boolean | no       | Include dotfiles. Default: `false`                      |
| `includeIgnored` | boolean | no       | Include ignored items. Default: `false`                 |
| `returnDiff`     | boolean | no       | Return diff even when not dry-run. Default: `false`     |
| `maxFiles`       | integer | no       | Max files to process before stopping (1-10000)          |
| `caseSensitive`  | boolean | no       | Case-sensitive matching. Default: `true`                |

### Resources

| Resource     | URI                            | MIME Type        | Description                                                        |
| ------------ | ------------------------------ | ---------------- | ------------------------------------------------------------------ |
| Instructions | `internal://instructions`      | text/markdown    | Comprehensive usage rules and guidelines                           |
| Tool Catalog | `internal://tool-catalog`      | text/markdown    | Tool selection guide and data flow map                             |
| Workflows    | `internal://workflows`         | text/markdown    | Standard operating procedures for exploration, search, edit, patch |
| Tool Info    | `internal://tool-info/{name}`  | text/markdown    | Per-tool contract details, nuances, gotchas                        |
| Result Cache | `filesystem-mcp://result/{id}` | text/plain       | Ephemeral cached tool output (large results externalized here)     |
| Metrics      | `filesystem-mcp://metrics`     | application/json | Live per-tool call/error/avgDurationMs snapshot                    |

### Prompts

| Prompt          | Arguments              | Description                                                            |
| --------------- | ---------------------- | ---------------------------------------------------------------------- |
| `get-help`      | `topic` (optional)     | Return usage instructions. Optionally filter by section heading prefix |
| `compare-files` | `original`, `modified` | Generate a workflow for comparing two files using `diff_files`         |
| `analyze-path`  | `path`                 | Generate a workflow for analyzing a file or directory                  |
| `get-tool-help` | `name`                 | Return a prompt with the authoritative contract for a specific tool    |

## MCP Capabilities

| Capability    | Status    | Evidence                                                                   |
| ------------- | --------- | -------------------------------------------------------------------------- |
| `logging`     | confirmed | `src/server/bootstrap.ts` — registered in capabilities                     |
| `resources`   | confirmed | `src/server/bootstrap.ts` — 6 resources registered                         |
| `tools`       | confirmed | `src/server/bootstrap.ts` — 18 tools registered                            |
| `prompts`     | confirmed | `src/server/bootstrap.ts` — 4 prompts registered                           |
| `completions` | confirmed | `src/completions.ts` — path, topic, and tool-name auto-completion          |
| `tasks`       | confirmed | `src/server/bootstrap.ts` — optional task support (list, cancel, requests) |

### Tool Annotations

| Annotation              | Tools                                                                                                           | Value                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `readOnlyHint: true`    | `roots`, `ls`, `find`, `tree`, `read`, `read_many`, `stat`, `stat_many`, `grep`, `calculate_hash`, `diff_files` | Read-only, idempotent, non-destructive |
| `destructiveHint: true` | `write`, `edit`, `rm`, `mv`, `search_and_replace`, `apply_patch`                                                | Destructive writes, not idempotent     |
| `idempotentHint: true`  | `mkdir`                                                                                                         | Idempotent write, non-destructive      |

### Structured Output

All 18 tools define `outputSchema` (Zod -> JSON Schema) and return `structuredContent` alongside text `content`. Set `FS_CONTEXT_STRIP_STRUCTURED=true` to strip output schemas from tool definitions (reduces token usage for LLMs that don't use structured output).

[↑ Back to top](#table-of-contents)

## Configuration

### HTTP & Auth

| Variable                           | Default          | Description                                                    |
| ---------------------------------- | ---------------- | -------------------------------------------------------------- |
| `FILESYSTEM_MCP_API_KEY`           | _(none)_         | Bearer token required when binding HTTP to a non-loopback host |
| `FILESYSTEM_MCP_MAX_HTTP_SESSIONS` | `100`            | Max concurrent HTTP sessions (1-10,000)                        |
| `FILESYSTEM_MCP_HTTP_HOST`         | `127.0.0.1`      | HTTP server bind address                                       |
| `FS_CONTEXT_MAX_REQUEST_BYTES`     | `4194304` (4 MB) | Max HTTP request body size (1 KB - 256 MB)                     |

### File Size Limits

| Variable                   | Default            | Description                                                   |
| -------------------------- | ------------------ | ------------------------------------------------------------- |
| `MAX_FILE_SIZE`            | `10485760` (10 MB) | Max file size for text read operations (1 MB - 100 MB)        |
| `MAX_SEARCH_SIZE`          | `1048576` (1 MB)   | Max file size for content search/grep (100 KB - 10 MB)        |
| `MAX_READ_MANY_TOTAL_SIZE` | `524288` (512 KB)  | Max cumulative size for `read_many` requests (10 KB - 100 MB) |
| `DEFAULT_SEARCH_TIMEOUT`   | `5000`             | Search operation timeout in ms (100 - 60,000)                 |

### Access Control

| Variable                     | Default  | Description                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------- |
| `FS_CONTEXT_ALLOW_SENSITIVE` | `false`  | Allow reading sensitive files (.env, .key, credentials, tokens)                 |
| `FS_CONTEXT_DENYLIST`        | _(none)_ | CSV/newline-separated glob patterns to block (in addition to built-in denylist) |
| `FS_CONTEXT_ALLOWLIST`       | _(none)_ | CSV/newline-separated glob patterns to permit (overrides denylist)              |

### Output & Inline Limits

| Variable                        | Default | Description                                                                    |
| ------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `FS_CONTEXT_MAX_INLINE_CHARS`   | `20000` | Max inline result chars before externalizing to `filesystem-mcp://result/{id}` |
| `FS_CONTEXT_MAX_INLINE_MATCHES` | `50`    | Max inline search matches before truncation                                    |
| `FS_CONTEXT_STRIP_STRUCTURED`   | `false` | Strip `outputSchema` from tool definitions (reduces tokens)                    |

### Tasks

| Variable                              | Default          | Description                                     |
| ------------------------------------- | ---------------- | ----------------------------------------------- |
| `FILESYSTEM_MCP_MAX_TASK_TTL_MS`      | `3600000` (1 hr) | Max task TTL before auto-eviction (1 s - 24 hr) |
| `FILESYSTEM_MCP_MAX_CONCURRENT_TASKS` | `100`            | Max simultaneous task executions (1-10,000)     |

### Logging & Diagnostics

| Variable                          | Default | Description                                                                    |
| --------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `FILESYSTEM_MCP_LOG_LEVEL`        | `info`  | MCP log level: debug, info, notice, warning, error, critical, alert, emergency |
| `FS_CONTEXT_DIAGNOSTICS`          | `false` | Enable diagnostic logging                                                      |
| `FS_CONTEXT_DIAGNOSTICS_DETAIL`   | `false` | Enable detailed diagnostic output                                              |
| `FS_CONTEXT_TOOL_LOG_ERRORS`      | `false` | Log tool errors to stderr                                                      |
| `FS_CONTEXT_SEARCH_WORKERS_DEBUG` | `false` | Debug logging for search worker pool                                           |

### Performance

| Variable                        | Default          | Description                              |
| ------------------------------- | ---------------- | ---------------------------------------- |
| `FS_CONTEXT_SEARCH_WORKERS`     | CPU cores (≤ 8)  | Concurrent search worker threads (1-16)  |
| `FS_CONTEXT_LIST_CURSOR_TTL_MS` | `300000` (5 min) | Cursor TTL for `ls` pagination snapshots |

[↑ Back to top](#table-of-contents)

## HTTP Endpoints

When started with `--port <number>`, the server exposes a single MCP endpoint:

| Method   | Path   | Purpose                                               |
| -------- | ------ | ----------------------------------------------------- |
| `POST`   | `/mcp` | Initialize session or send requests (Streamable HTTP) |
| `GET`    | `/mcp` | HTTP streaming session endpoint                       |
| `DELETE` | `/mcp` | Terminate a session                                   |

**Required headers:**

- `mcp-protocol-version` — use the negotiated MCP protocol version on post-initialize HTTP requests
- `mcp-session-id` — required for `GET`/`DELETE` (returned by `POST` on initialize)

**Authentication:** Requests to non-loopback HTTP binds require `FILESYSTEM_MCP_API_KEY`; clients must then send `Authorization: Bearer <key>`. Loopback-only binds may omit auth for local use. Uses SHA-256 timing-safe comparison.

**CORS:** Only localhost origins allowed (`127.0.0.1`, `::1`, `localhost`).

## Security

| Control                   | Status    | Evidence                                                                               |
| ------------------------- | --------- | -------------------------------------------------------------------------------------- |
| Path sandboxing           | confirmed | `src/lib/paths.ts` — all paths validated against allowed roots                         |
| Traversal prevention      | confirmed | `src/lib/paths.ts` — resolved paths checked after normalization                        |
| Symlink escape prevention | confirmed | `src/__tests__/security.test.ts` — symlink boundary enforcement                        |
| Sensitive file denylist   | confirmed | `src/lib/constants.ts` — blocks `.git`, `.env*`, SSH keys, certs, secrets              |
| Origin validation         | confirmed | `src/server/bootstrap.ts` — localhost-only Origin allowlist                            |
| Bearer auth               | confirmed | `src/server/bootstrap.ts` — optional `FILESYSTEM_MCP_API_KEY` with timing-safe compare |
| Input validation          | confirmed | `src/schemas.ts` — Zod strict schemas on all tool inputs                               |
| Request body limit        | confirmed | `src/server/bootstrap.ts` — configurable max request size (413 on overflow)            |
| Remote bind guard         | confirmed | `src/server/bootstrap.ts` — refuses non-loopback bind without `FILESYSTEM_MCP_API_KEY` |

[↑ Back to top](#table-of-contents)

## Development

- `dev` — `tsc --watch --preserveWatchOutput` — Watch mode TypeScript compilation
- `dev:run` — `node --env-file=.env --watch dist/index.js` — Run server with auto-reload
- `start` — `node dist/index.js` — Run production server
- `build` — `node scripts/tasks.mjs build` — Clean build
- `test` — `node scripts/tasks.mjs test` — Build + run all tests
- `test:fast` — `node --test --import tsx/esm src/__tests__/**/*.test.ts node-tests/**/*.test.ts` — Run tests without build
- `lint` — `eslint .` — Lint source
- `type-check` — `node scripts/tasks.mjs type-check` — Type-check src + tests
- `format` — `prettier --write .` — Format code
- `inspector` — `npm run build && npx -y @modelcontextprotocol/inspector node dist/index.js ${workspaceFolder}` — Launch MCP Inspector

## Build and Release

- **CI:** `.github/workflows/release.yml` — runs lint, type-check, test, build before tagging/publishing.
- **Docker:** Multi-stage build with `node:24-alpine`. Builder compiles TypeScript + native modules (re2); release stage runs as non-root `mcp` user.
- **npm:** `npm run prepublishOnly` runs lint + type-check + build.

## Troubleshooting

- **"No allowed directories"** — Pass at least one directory argument or use `--allow-cwd`.
- **Sensitive file blocked** — Files matching the denylist (`.env*`, `.git`, SSH keys) are blocked by design. Check `src/lib/constants.ts` for the full list.
- **Large result externalized** — When tool output exceeds inline limits, it's cached as a resource at `filesystem-mcp://result/{id}`. Read the resource URI to get the full content.
- **Stdio: logs on stdout** — Keep logs on stderr only. The server uses `console.error` for diagnostics.
- **HTTP 413** — Request body exceeds `FS_CONTEXT_MAX_REQUEST_BYTES`. Increase the limit or reduce payload size.
- **HTTP 401** — `FILESYSTEM_MCP_API_KEY` is set but the request is missing or has an incorrect `Authorization: Bearer` header.

## Credits

| Dependency                                                                                 | Description                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| [@modelcontextprotocol/server](https://www.npmjs.com/package/@modelcontextprotocol/server) | MCP server SDK package                        |
| [@modelcontextprotocol/client](https://www.npmjs.com/package/@modelcontextprotocol/client) | MCP client SDK package                        |
| [@modelcontextprotocol/node](https://www.npmjs.com/package/@modelcontextprotocol/node)     | Node transport package for MCP runtime        |
| [commander](https://www.npmjs.com/package/commander)                                       | CLI argument parsing                          |
| [diff](https://www.npmjs.com/package/diff)                                                 | Unified diff generation and patch application |
| [ignore](https://www.npmjs.com/package/ignore)                                             | `.gitignore` pattern matching                 |
| [re2](https://www.npmjs.com/package/re2)                                                   | Safe RE2 regex engine (no ReDoS)              |
| [zod](https://www.npmjs.com/package/zod)                                                   | Schema validation and JSON Schema generation  |

## License

MIT License. See [LICENSE](LICENSE) for details.

[↑ Back to top](#table-of-contents)
