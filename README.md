# Filesystem MCP

![npm version](https://img.shields.io/npm/v/@j0hanz/filesystem-mcp) ![License](https://img.shields.io/npm/l/@j0hanz/filesystem-mcp) ![Node.js Version](https://img.shields.io/node/v/@j0hanz/filesystem-mcp) ![Docker Image](https://ghcr-badge.egpl.dev/j0hanz/filesystem-mcp/latest_tag?trim=major&label=docker)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/deeplink/mcp-install?name=filesystem-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

MCP Server that enables LLMs to interact with the local filesystem. Provides tools for navigation, search, file management, and analysis — all scoped to allowed directories.

## Overview

Filesystem MCP exposes a rich set of tools for reading, writing, searching, and inspecting files and directories. All operations are strictly bounded to the directories you provide at startup, preventing access to any path outside those roots.

## Key Features

- **Navigation**: List directory contents (`ls`), render trees (`tree`), and query workspace roots (`roots`).
- **File I/O**: Read single or multiple files (`read`, `read_many`); write, edit, move, and delete (`write`, `edit`, `mv`, `rm`).
- **Search**: Find files by glob pattern (`find`) or search content with full regex support (`grep`).
- **Analysis**: Metadata and token estimates (`stat`, `stat_many`), SHA-256 hashing (`calculate_hash`), and unified diffs (`diff_files`).
- **Patch & Replace**: Apply unified patches (`apply_patch`) and bulk search-and-replace across files (`search_and_replace`).
- **Tasks**: Long-running tools support background task execution with progress notifications and cancellation.
- **Large Output Handling**: Oversized results are externalized to ephemeral resource URIs instead of truncating inline.
- **Security**: Strict path validation, safe regex via RE2, `.gitignore`-aware operations, and atomic writes.

## Requirements

- **Node.js** `>= 24`

## Quick Start

```json
{
  "mcpServers": {
    "filesystem-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/allowed/dir"]
    }
  }
}
```

Run directly:

```bash
npx -y @j0hanz/filesystem-mcp@latest /path/to/allowed/dir
```

## Client Configuration

<details>
<summary><b>Install in VS Code</b></summary>

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D)

Or add manually to `.vscode/mcp.json`:

```json
{
  "servers": {
    "filesystem-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "${workspaceFolder}"]
    }
  }
}
```

CLI:

```bash
code --add-mcp '{"name":"filesystem-mcp","command":"npx","args":["-y","@j0hanz/filesystem-mcp@latest","${workspaceFolder}"]}'
```

</details>

<details>
<summary><b>Install in VS Code Insiders</b></summary>

[![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_Server-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem-mcp&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-mcp%40latest%22%5D%7D&quality=insiders)

CLI:

```bash
code-insiders --add-mcp '{"name":"filesystem-mcp","command":"npx","args":["-y","@j0hanz/filesystem-mcp@latest","${workspaceFolder}"]}'
```

</details>

<details>
<summary><b>Install in Cursor</b></summary>

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/deeplink/mcp-install?name=filesystem-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1tY3BAbGF0ZXN0Il19)

Or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "filesystem-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/dir"]
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
    "filesystem-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/dir"]
    }
  }
}
```

</details>

<details>
<summary><b>Install in Claude Code</b></summary>

```bash
claude mcp add filesystem-mcp -- npx -y @j0hanz/filesystem-mcp@latest /path/to/dir
```

</details>

<details>
<summary><b>Install in Windsurf</b></summary>

```json
{
  "mcpServers": {
    "filesystem-mcp": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-mcp@latest", "/path/to/dir"]
    }
  }
}
```

</details>

<details>
<summary><b>Install in Codex</b></summary>

```toml
[mcp_servers.filesystem-mcp]
command = "npx"
args = ["-y", "@j0hanz/filesystem-mcp@latest", "${workspaceFolder}"]
```

</details>

<details>
<summary><b>Docker</b></summary>

```bash
docker run -i --rm \
  -v /path/to/your/project:/projects/workspace:ro \
  ghcr.io/j0hanz/filesystem-mcp:latest \
  /projects/workspace
```

MCP config:

```json
{
  "mcpServers": {
    "filesystem-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/path/to/project:/projects/workspace:ro",
        "ghcr.io/j0hanz/filesystem-mcp:latest",
        "/projects/workspace"
      ]
    }
  }
}
```

</details>

## MCP Surface

### Tools

| Tool                 | Description                                          |
| :------------------- | :--------------------------------------------------- |
| `roots`              | List workspace roots the server can access           |
| `ls`                 | List directory contents (non-recursive)              |
| `find`               | Find files by glob pattern                           |
| `tree`               | Render a bounded directory tree                      |
| `read`               | Read text content of a file                          |
| `read_many`          | Read multiple files in one request                   |
| `stat`               | Get file or directory metadata                       |
| `stat_many`          | Get metadata for multiple paths                      |
| `grep`               | Search file content by literal or RE2 regex          |
| `calculate_hash`     | Compute SHA-256 hash of a file or directory          |
| `diff_files`         | Generate a unified diff between two files            |
| `mkdir`              | Create a directory (recursive)                       |
| `write`              | Write content to a file (create or overwrite)        |
| `edit`               | Edit a file via sequential string replacements       |
| `mv`                 | Move or rename a file or directory                   |
| `rm`                 | Delete a file or directory                           |
| `apply_patch`        | Apply a unified diff patch to a file                 |
| `search_and_replace` | Search and replace text across files matching a glob |

---

#### `roots` — List workspace roots

Enumerate the directories the server is allowed to access. Call this first in any session.

No input parameters.

---

#### `ls` — List directory contents

List immediate directory contents (non-recursive). Returns name, type, size, and modified date per entry.

| Parameter               | Type                               | Required | Default | Description                                               |
| :---------------------- | :--------------------------------- | :------: | :------ | :-------------------------------------------------------- |
| `path`                  | string                             |    No    | root    | Base directory                                            |
| `includeHidden`         | boolean                            |    No    | `false` | Include hidden items (`.`)                                |
| `includeIgnored`        | boolean                            |    No    | `false` | Include `node_modules`, `.git`, etc.                      |
| `pattern`               | string                             |    No    | —       | Glob filter enabling recursive traversal (e.g. `**/*.ts`) |
| `sortBy`                | `name`\|`size`\|`modified`\|`type` |    No    | `name`  | Sort field                                                |
| `maxDepth`              | integer                            |    No    | —       | Max recursion depth when `pattern` is set (1–50)          |
| `maxEntries`            | integer                            |    No    | —       | Truncation limit (1–20,000)                               |
| `includeSymlinkTargets` | boolean                            |    No    | `false` | Resolve and include symlink targets                       |

---

#### `find` — Find files by glob

Locate files matching a glob pattern. Returns relative paths and metadata.

| Parameter        | Type                               | Required | Default | Description                                         |
| :--------------- | :--------------------------------- | :------: | :------ | :-------------------------------------------------- |
| `pattern`        | string                             |   Yes    | —       | Glob pattern (e.g. `**/*.ts`, `src/*.js`)           |
| `path`           | string                             |    No    | root    | Search root                                         |
| `maxResults`     | integer                            |    No    | `100`   | Max results (1–10,000)                              |
| `maxDepth`       | integer                            |    No    | —       | Max directory depth to scan (0–100)                 |
| `sortBy`         | `name`\|`size`\|`modified`\|`path` |    No    | `path`  | Sort field                                          |
| `includeHidden`  | boolean                            |    No    | `false` | Include hidden files                                |
| `includeIgnored` | boolean                            |    No    | `false` | Include ignored directories (disables `.gitignore`) |

> [!TIP]
> Supports background task execution with progress reporting.

---

#### `tree` — Render directory tree

Returns both an ASCII tree (text) and a structured JSON tree.

| Parameter        | Type    | Required | Default | Description                                         |
| :--------------- | :------ | :------: | :------ | :-------------------------------------------------- |
| `path`           | string  |    No    | root    | Base directory                                      |
| `maxDepth`       | integer |    No    | `5`     | Max depth (0–50); `0` = root node only, no children |
| `maxEntries`     | integer |    No    | `1000`  | Max entries (1–20,000)                              |
| `includeHidden`  | boolean |    No    | `false` | Include hidden items                                |
| `includeIgnored` | boolean |    No    | `false` | Include ignored items (disables `.gitignore`)       |

---

#### `read` — Read file content

Read text content of a single file with optional line-range or head preview.

| Parameter   | Type    | Required | Default | Description                                                                   |
| :---------- | :------ | :------: | :------ | :---------------------------------------------------------------------------- |
| `path`      | string  |   Yes    | —       | Absolute path to file                                                         |
| `head`      | integer |    No    | —       | Read first N lines (1–100,000); mutually exclusive with `startLine`/`endLine` |
| `startLine` | integer |    No    | —       | Start line (1-based, inclusive)                                               |
| `endLine`   | integer |    No    | —       | End line (1-based, inclusive); requires `startLine`                           |

Large files return a `resourceUri`; call `resources/read` on that URI for full content.

---

#### `read_many` — Read multiple files

Batch-read up to 100 files in a single request.

| Parameter   | Type     | Required | Default | Description                              |
| :---------- | :------- | :------: | :------ | :--------------------------------------- |
| `paths`     | string[] |   Yes    | —       | File paths (1–100 items)                 |
| `head`      | integer  |    No    | —       | Read first N lines of each file          |
| `startLine` | integer  |    No    | —       | Start line per file                      |
| `endLine`   | integer  |    No    | —       | End line per file (requires `startLine`) |

Per-file `truncationReason` can be `head`, `range`, or `externalized`. Total read budget is capped internally.

---

#### `stat` — Get file/directory metadata

Returns name, type, size, created/modified/accessed timestamps, permissions, MIME type, and a token estimate (`size ÷ 4`).

| Parameter | Type   | Required | Default | Description   |
| :-------- | :----- | :------: | :------ | :------------ |
| `path`    | string |   Yes    | —       | Absolute path |

---

#### `stat_many` — Get metadata for multiple paths

Batch version of `stat`.

| Parameter | Type     | Required | Default | Description         |
| :-------- | :------- | :------: | :------ | :------------------ |
| `paths`   | string[] |   Yes    | —       | Paths (1–100 items) |

---

#### `grep` — Search file content

Search for text within files using literal match or RE2 regex. Returns matching lines with optional context.

| Parameter        | Type    | Required | Default | Description                                                         |
| :--------------- | :------ | :------: | :------ | :------------------------------------------------------------------ |
| `pattern`        | string  |   Yes    | —       | Text to search (literal by default, RE2 regex when `isRegex: true`) |
| `path`           | string  |    No    | root    | Search root (file or directory)                                     |
| `isRegex`        | boolean |    No    | `false` | Treat `pattern` as RE2 regex                                        |
| `caseSensitive`  | boolean |    No    | `false` | Case-sensitive matching                                             |
| `wholeWord`      | boolean |    No    | `false` | Match whole words only                                              |
| `contextLines`   | integer |    No    | `0`     | Lines of context before/after each match (0–50)                     |
| `maxResults`     | integer |    No    | `500`   | Max match rows returned (0–10,000)                                  |
| `filePattern`    | string  |    No    | `**/*`  | Glob to restrict candidate files (e.g. `**/*.ts`)                   |
| `includeHidden`  | boolean |    No    | `false` | Include hidden files                                                |
| `includeIgnored` | boolean |    No    | `false` | Include ignored directories                                         |

> [!NOTE]
> RE2 does not support lookahead, lookbehind, or backreferences. Results exceeding 50 inline matches are externalized via `resourceUri`.

---

#### `calculate_hash` — SHA-256 hash

Compute a SHA-256 hash. For directories, produces a deterministic composite hash of all contained files (lexicographically sorted, `.gitignore`-aware).

| Parameter | Type   | Required | Default | Description            |
| :-------- | :----- | :------: | :------ | :--------------------- |
| `path`    | string |   Yes    | —       | File or directory path |

---

#### `diff_files` — Generate unified diff

Create a unified diff between two files. Check `isIdentical` in the response — if `true`, the files match and no patch is needed.

| Parameter          | Type    | Required | Default | Description                        |
| :----------------- | :------ | :------: | :------ | :--------------------------------- |
| `original`         | string  |   Yes    | —       | Original file path                 |
| `modified`         | string  |   Yes    | —       | Modified file path                 |
| `context`          | integer |    No    | —       | Lines of context in the diff       |
| `ignoreWhitespace` | boolean |    No    | `false` | Ignore leading/trailing whitespace |
| `stripTrailingCr`  | boolean |    No    | `false` | Strip trailing carriage returns    |

Large diffs are externalized to a `resourceUri`.

---

#### `mkdir` — Create directory

Create a directory and all missing parent directories (recursive).

| Parameter | Type   | Required | Default | Description              |
| :-------- | :----- | :------: | :------ | :----------------------- |
| `path`    | string |   Yes    | —       | Directory path to create |

---

#### `write` — Write file

Create or overwrite a file. Parent directories are created automatically.

| Parameter | Type   | Required | Default | Description      |
| :-------- | :----- | :------: | :------ | :--------------- |
| `path`    | string |   Yes    | —       | File path        |
| `content` | string |   Yes    | —       | Content to write |

> [!CAUTION]
> Overwrites existing file content without confirmation.

---

#### `edit` — Edit file

Apply sequential literal string replacements to an existing file. Replaces the **first** occurrence of each `oldText`.

| Parameter | Type                   | Required | Default | Description                            |
| :-------- | :--------------------- | :------: | :------ | :------------------------------------- |
| `path`    | string                 |   Yes    | —       | File to edit                           |
| `edits`   | `{oldText, newText}[]` |   Yes    | —       | Ordered list of replacement operations |
| `dryRun`  | boolean                |    No    | `false` | Validate edits without writing         |

Include 3–5 lines of surrounding context in `oldText` to uniquely target the location. Unmatched edits are reported in `unmatchedEdits`.

---

#### `mv` — Move or rename

Move or rename a file or directory. Parent directories of the destination are created automatically. Falls back to copy+delete for cross-device moves.

| Parameter     | Type   | Required | Default | Description      |
| :------------ | :----- | :------: | :------ | :--------------- |
| `source`      | string |   Yes    | —       | Source path      |
| `destination` | string |   Yes    | —       | Destination path |

---

#### `rm` — Delete file or directory

Delete a file or directory.

| Parameter           | Type    | Required | Default | Description                     |
| :------------------ | :------ | :------: | :------ | :------------------------------ |
| `path`              | string  |   Yes    | —       | Path to delete                  |
| `recursive`         | boolean |    No    | `false` | Delete non-empty directories    |
| `ignoreIfNotExists` | boolean |    No    | `false` | No error if the path is missing |

> [!WARNING]
> Non-empty directories with `recursive: false` return `E_INVALID_INPUT` with guidance to retry using `recursive: true`.

---

#### `apply_patch` — Apply unified patch

Apply a unified diff patch to a file. Always validate with `dryRun: true` before writing.

| Parameter                | Type    | Required | Default | Description                                            |
| :----------------------- | :------ | :------: | :------ | :----------------------------------------------------- |
| `path`                   | string  |   Yes    | —       | Target file path                                       |
| `patch`                  | string  |   Yes    | —       | Unified diff patch content (must include hunk headers) |
| `fuzzFactor`             | integer |    No    | `0`     | Fuzzy matching tolerance                               |
| `autoConvertLineEndings` | boolean |    No    | `true`  | Auto-convert line endings to match the target file     |
| `dryRun`                 | boolean |    No    | `false` | Validate without writing                               |

If patch application fails, regenerate a fresh patch via `diff_files` against the current file content and retry.

---

#### `search_and_replace` — Search and replace across files

Replace text in all files matching a glob. Replaces **all** occurrences per file. Use `dryRun: true` to preview scope before writing.

| Parameter       | Type    | Required | Default | Description                                                              |
| :-------------- | :------ | :------: | :------ | :----------------------------------------------------------------------- |
| `filePattern`   | string  |   Yes    | —       | Glob for target files (e.g. `**/*.ts`)                                   |
| `searchPattern` | string  |   Yes    | —       | Text to find                                                             |
| `replacement`   | string  |   Yes    | —       | Replacement text                                                         |
| `path`          | string  |    No    | root    | Search root directory                                                    |
| `isRegex`       | boolean |    No    | `false` | Treat `searchPattern` as RE2 regex; supports capture groups (`$1`, `$2`) |
| `dryRun`        | boolean |    No    | `false` | Preview matches without writing                                          |

---

### Resources

| URI                            | Description                         | MIME Type          |
| :----------------------------- | :---------------------------------- | :----------------- |
| `internal://instructions`      | Usage guidance for models           | `text/markdown`    |
| `internal://tool-catalog`      | Tool routing and data-flow guide    | `text/markdown`    |
| `internal://workflows`         | Explore/search/edit/patch workflows | `text/markdown`    |
| `internal://tool-info/{name}`  | Per-tool nuances and gotchas        | `text/markdown`    |
| `filesystem-mcp://metrics`     | Live per-tool metrics snapshot      | `application/json` |
| `filesystem-mcp://result/{id}` | Ephemeral cached large tool output  | varies             |

When a tool response includes a `resource_link`/`resourceUri`, treat it as authoritative for full payload retrieval and call `resources/read` with that URI.

### Prompts

| Prompt     | Description                               |
| :--------- | :---------------------------------------- |
| `get-help` | Returns usage instructions for the server |

### Tasks (Background Execution)

The server declares full task capabilities (`tasks/list`, `tasks/cancel`). The following tools support task-based invocation with progress notifications:

`find`, `tree`, `read`, `read_many`, `stat_many`, `grep`, `mkdir`, `write`, `mv`, `rm`, `calculate_hash`, `apply_patch`, `search_and_replace`

Include `_meta.progressToken` in a `tools/call` request to receive `notifications/progress` updates. Use `tools/call` with a `task` field to invoke as a background task, then poll `tasks/get` and retrieve output via `tasks/result`.

Recommended task follow-up loop:

1. Start with `tools/call` + `task` (optional `_meta.progressToken`).
2. Poll `tasks/get` until terminal status (`completed`, `failed`, `cancelled`).
3. Fetch final payload with `tasks/result`.

Task status notifications (`notifications/tasks/status`) are best-effort and emitted only when the transport/runtime provides a notification sender.

Cancellation semantics:

- `tasks/cancel` is the canonical cancellation API.
- Clients should treat `E_CANCELLED` as cancellation even if a transport/client surfaces a terminal failure shape.

## Configuration

### CLI

```text
filesystem-mcp [options] [allowedDirs...]
```

| Option             | Description                                               |
| :----------------- | :-------------------------------------------------------- |
| `[allowedDirs...]` | Positional: one or more directories the server may access |
| `--allow-cwd`      | Allow the current working directory as an additional root |
| `-v, --version`    | Display server version                                    |
| `-h, --help`       | Display help                                              |

Examples:

```bash
# Single directory
filesystem-mcp /project/src

# Multiple directories
filesystem-mcp /project/src /project/tests

# Current working directory
filesystem-mcp --allow-cwd

# Combined
filesystem-mcp /project/src --allow-cwd
```

### Allowed Directories

Directories are resolved from three sources, merged at runtime:

1. **CLI arguments** — positional directory paths passed at startup.
2. **MCP Roots protocol** — directories provided by the connected client after initialization (accepted only if they are within the CLI baseline when CLI directories are set).
3. **`--allow-cwd`** — the current working directory is added automatically.

> [!TIP]
> If no directories are configured at startup and the connected client does not supply MCP Roots, all tool calls will fail. Pass at least one directory argument or use `--allow-cwd`.

### Compatibility

Set `FS_CONTEXT_STRIP_STRUCTURED=1` to strip `structuredContent` from tool results and `outputSchema` from tool definitions for compatibility with clients that only consume text content.

## Security

- **Path validation**: All operations use `isPathWithinDirectories` to prevent path traversal attacks.
- **Glob safety**: Glob patterns are validated to reject absolute paths and `..` traversal before execution.
- **Safe regex**: `re2` executes regex (no catastrophic backtracking); `safe-regex2` rejects unsafe patterns before use.
- **Hidden files**: Excluded from listings and searches by default; opt in with `includeHidden: true`.
- **Ignored directories**: `node_modules`, `.git`, `dist`, and similar directories are excluded by default; opt in with `includeIgnored: true`.
- **Windows safety**: Reserved device names (e.g. `CON`, `NUL`, `COM1`) and drive-relative paths (e.g. `C:path`) are rejected at the CLI.
- **Input limits**: Paths are bounded to 4,096 characters; patterns to 1,000 characters.
- **Atomic writes**: File writes use an atomic write-then-rename strategy to prevent partial writes.
- **Docker**: The container runs as a non-root user (`mcp`).
- **HTTP host binding**: The HTTP transport binds to `127.0.0.1` by default. Setting `FILESYSTEM_MCP_HTTP_HOST=0.0.0.0` binds to all network interfaces and exposes the server externally — only do this behind a trusted reverse proxy with `FILESYSTEM_MCP_API_KEY` configured.

> [!IMPORTANT]
> All diagnostic output goes to `stderr`. Tool handlers must never write to `stdout`, as doing so would corrupt the stdio transport.

## Development

### Install

```bash
npm ci
```

### Scripts

| Script       | Command                             | Purpose                             |
| :----------- | :---------------------------------- | :---------------------------------- |
| `dev`        | `tsc --watch`                       | Watch-mode TypeScript compilation   |
| `dev:run`    | `node --watch dist/index.js`        | Run built server with file watching |
| `build`      | `node scripts/tasks.mjs build`      | Production build                    |
| `test`       | `node scripts/tasks.mjs test`       | Run full test suite                 |
| `lint`       | `eslint .`                          | Lint source files                   |
| `lint:fix`   | `eslint . --fix`                    | Auto-fix lint issues                |
| `format`     | `prettier --write .`                | Format all files                    |
| `type-check` | `node scripts/tasks.mjs type-check` | TypeScript type checking            |

### MCP Inspector

```bash
npm run inspector
```

Or manually:

```bash
npx @modelcontextprotocol/inspector node dist/index.js /path/to/dir
```

## Build & Release

Releases are triggered manually via [GitHub Actions](.github/workflows/release.yml) (`workflow_dispatch`). The pipeline:

1. Bumps `package.json` and `server.json` to the selected version (patch / minor / major or custom).
2. Runs lint, type-check, tests, and build.
3. Commits, tags (`vX.Y.Z`), and creates a GitHub Release with auto-generated notes.
4. Publishes to **npm** (`@j0hanz/filesystem-mcp`) with OIDC provenance.
5. Publishes to the **MCP Registry** (`io.github.j0hanz/filesystem-mcp`).
6. Builds and pushes the **Docker image** (`ghcr.io/j0hanz/filesystem-mcp`) for `linux/amd64` and `linux/arm64`.

The [Glama](https://glama.ai/mcp/servers/j0hanz/filesystem-mcp) listing requires a separate manual release step on the Glama dashboard.

### Docker Build (local)

```bash
docker build -t filesystem-mcp .
```

## HTTP Conformance Notes

For Streamable HTTP clients, this server enforces the following behavior:

- Session-bound requests must include `MCP-Protocol-Version: 2025-11-25`; missing or unsupported values return `400`.
- Requests with invalid or expired `mcp-session-id` return `404`.
- Initialize requests continue to be accepted without a session ID.

## Backlog Hardening (Planned)

The following hardening items are intentionally tracked as follow-up work:

- Add a TTL-evicting task store for long-lived HTTP deployments to bound memory usage.
- Add an optional per-session roots isolation mode for multi-tenant HTTP deployments.

## Troubleshooting

**No directories configured**
If no directories are provided at startup and the client doesn't supply MCP Roots, all tool calls fail with `E_ACCESS_DENIED`. Use `roots` to inspect configured roots.

**Path outside allowed directories**
Tools return `E_ACCESS_DENIED` when a path is outside all allowed roots. Use `roots` first to see what is available.

**Empty directory or no matches**
`find` and `grep` return empty results rather than errors when nothing matches. Verify the pattern and root path.

**Pattern rejected (`E_INVALID_PATTERN`)**
Glob patterns cannot be absolute or use `..` to traverse upward. RE2 patterns are validated before use.

**Non-empty directory delete fails**
`rm` returns `E_INVALID_INPUT` for non-empty directories without `recursive: true`. Either set `recursive: true` or remove contents first.

**Patch application failed**
`apply_patch` requires valid unified hunk headers (`@@ -N,M +N,M @@`). Regenerate the patch with `diff_files` against the current file content and retry.

**Stdout contamination**
The server uses stdio transport. Never write to `stdout` in custom integrations. All diagnostic output goes to `stderr`. For Claude Desktop, check `~/Library/Logs/Claude/mcp*.log` (macOS) or the equivalent on Windows.

## License

[MIT](LICENSE)
