# FS Context MCP Server

<img src="docs/logo.png" alt="FS Context MCP Server Logo" width="125">

A secure, read-only MCP server for filesystem scanning, searching, and analysis with comprehensive security validation.

[![npm version](https://img.shields.io/npm/v/@j0hanz/fs-context-mcp.svg)](https://www.npmjs.com/package/@j0hanz/fs-context-mcp)
[![License](https://img.shields.io/npm/l/@j0hanz/fs-context-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.25.2-purple)](https://modelcontextprotocol.io)

## One-Click Install

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fs-context&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffs-context-mcp%40latest%22%2C%22%24%7BworkspaceFolder%7D%22%5D%7D)[![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=fs-context&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffs-context-mcp%40latest%22%2C%22%24%7BworkspaceFolder%7D%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=fs-context&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZnMtY29udGV4dC1tY3BAbGF0ZXN0IiwiJHt3b3Jrc3BhY2VGb2xkZXJ9Il19)

## Features

- Directory listing (immediate contents)
- File search with glob patterns
- Content search with regex and context lines
- File reading with head previews (first N lines)
- Batch reads and metadata lookups in parallel
- Security: path validation, symlink escape protection, read-only operations

## When to Use

| Task                            | Tool        |
| ------------------------------- | ----------- |
| Explore project structure       | `ls`        |
| Find files                      | `find`      |
| Search for code patterns/text   | `grep`      |
| Read source code                | `read`      |
| Batch read multiple files       | `read_many` |
| Get file metadata (size, dates) | `stat`      |
| Batch get file metadata         | `stat_many` |
| Check available directories     | `roots`     |

## Quick Start

### NPX (recommended)

Allow the current working directory explicitly:

```bash
npx -y @j0hanz/fs-context-mcp@latest --allow-cwd
```

Or pass explicit directories:

```bash
npx -y @j0hanz/fs-context-mcp@latest /path/to/project /path/to/docs
```

If your MCP client supports the Roots protocol, you can omit directory arguments and let the client provide allowed directories. Otherwise, pass explicit directories or use `--allow-cwd` (if neither is provided, the server defaults to the current working directory).

### VS Code (workspace folder)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "fs-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fs-context-mcp@latest", "${workspaceFolder}"]
    }
  }
}
```

## Installation

### NPX (no install)

```bash
npx -y @j0hanz/fs-context-mcp@latest /path/to/dir1 /path/to/dir2
```

### Global installation

```bash
npm install -g @j0hanz/fs-context-mcp
fs-context-mcp /path/to/your/project
```

### From source

```bash
git clone https://github.com/j0hanz/fs-context-mcp-server.git
cd fs-context-mcp-server
npm install
npm run build
node dist/index.js /path/to/your/project
```

## Directory Access and Resolution

Access is always restricted to explicitly allowed directories.

1. CLI directories are validated and added first (if provided).
2. `--allow-cwd` optionally adds the current working directory.
3. MCP Roots from the client are used next:
   - If CLI and/or `--allow-cwd` are provided, only roots inside those baseline directories are accepted.
   - If no baseline is provided, roots become the allowed directories.
4. If nothing is configured and the client provides no roots, the server defaults to the current working directory and logs a warning.

Notes:

- Windows drive-relative paths like `C:path` are rejected. Use `C:\path` or `C:/path`.
- Reserved Windows device names (e.g., `CON`, `NUL`) are blocked.

## Configuration

All configuration is optional. Sizes in bytes, timeouts in milliseconds.

### Environment Variables

| Variable                    | Default           | Description                                               |
| --------------------------- | ----------------- | --------------------------------------------------------- |
| `MAX_FILE_SIZE`             | 10MB              | Max file size for read operations (range: 1MB-100MB)      |
| `MAX_SEARCH_SIZE`           | 1MB               | Max file size for content search (range: 100KB-10MB)      |
| `DEFAULT_SEARCH_TIMEOUT`    | 30000             | Timeout for search/list operations (range: 100-3600000ms) |
| `FS_CONTEXT_SEARCH_WORKERS` | min(cpu cores, 8) | Search worker threads (range: 1-16)                       |

See [CONFIGURATION.md](CONFIGURATION.md) for examples and CLI usage.

## Tools

All tools return both human-readable text and structured JSON. Structured
responses include `ok`, optional `error` (with `code`, `message`, `path`,
`suggestion`), plus the tool-specific fields documented below.

### `roots`

List all directories that this server can access.

| Parameter | Type | Required | Default | Description |
| --------- | ---- | -------- | ------- | ----------- |
| (none)    | -    | -        | -       | -           |

Returns: Allowed directory paths. Structured output includes `ok` and
`directories`.

---

### `ls`

List the immediate contents of a directory (non-recursive). Omit `path` to use
the first allowed root. If `pattern` is provided, listing is recursive up to
`maxDepth`.

| Parameter               | Type     | Required | Default      | Description                                              |
| ----------------------- | -------- | -------- | ------------ | -------------------------------------------------------- |
| `path`                  | string   | No       | `first root` | Directory path to list (omit to use first root)          |
| `includeHidden`         | boolean  | No       | `false`      | Include hidden files and directories                     |
| `excludePatterns`       | string[] | No       | `[]`         | Glob patterns to exclude                                 |
| `pattern`               | string   | No       | -            | Glob pattern to include (relative, no `..`)              |
| `maxDepth`              | number   | No       | `10`         | Maximum depth when using pattern (0-100)                 |
| `maxEntries`            | number   | No       | `10000`      | Maximum entries to return (1-100000)                     |
| `timeoutMs`             | number   | No       | `30000`      | Timeout in milliseconds                                  |
| `sortBy`                | string   | No       | `name`       | Sort by: `name`, `size`, `modified`, `type`              |
| `includeSymlinkTargets` | boolean  | No       | `false`      | Include symlink target paths (symlinks are not followed) |

Returns: Entries with name, relativePath, type, size, and modified time.
Structured output includes `ok`, `path`, `entries`, and `totalEntries`.

---

### `find`

Search for files using glob patterns. Omit `path` to search from the first
allowed root. `find` does not apply a built-in exclude list; scope your pattern
to avoid dependency/build directories (e.g., `src/**/*.ts`).

| Parameter    | Type   | Required | Default      | Description                                            |
| ------------ | ------ | -------- | ------------ | ------------------------------------------------------ |
| `path`       | string | No       | `first root` | Base directory to search from (omit to use first root) |
| `pattern`    | string | Yes      | -            | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`)          |
| `maxResults` | number | No       | `100`        | Maximum matches to return (1-10000)                    |

Returns: Matching paths (relative) with size and modified date. Structured
output includes `ok`, `results`, `totalMatches`, and `truncated`.

---

### `read`

Read the contents of a text file.

| Parameter | Type   | Required | Default | Description             |
| --------- | ------ | -------- | ------- | ----------------------- |
| `path`    | string | Yes      | -       | File path to read       |
| `head`    | number | No       | -       | Read only first N lines |

Notes:

- Reads are UTF-8 text only; binary files are rejected.
- Full reads are capped by `MAX_FILE_SIZE` (default 10MB). When `head` is set,
  output stops at the line limit or size budget, whichever comes first.

Returns: File content plus structured metadata (`ok`, `path`, `content`,
`truncated`, `totalLines`).

---

### `read_many`

Read multiple files in parallel.

| Parameter | Type     | Required | Default | Description                          |
| --------- | -------- | -------- | ------- | ------------------------------------ |
| `paths`   | string[] | Yes      | -       | Array of file paths (max 100)        |
| `head`    | number   | No       | -       | Read only first N lines of each file |

Notes:

- Reads files as UTF-8 text; binary files are not filtered. Max size per file
  is capped by `MAX_FILE_SIZE` (default 10MB).
- Total read budget across all files is capped at 100MB.
- No binary detection is performed; use `read` for single-file safety checks.

Returns: Per-file content or error, plus structured summary (`total`,
`succeeded`, `failed`).

---

### `stat`

Get detailed metadata about a file or directory.

| Parameter | Type   | Required | Default | Description               |
| --------- | ------ | -------- | ------- | ------------------------- |
| `path`    | string | Yes      | -       | Path to file or directory |

Returns: name, path, type, size, timestamps (created/modified/accessed),
permissions, hidden status, MIME type (for files), and symlink target (if
applicable).

---

### `stat_many`

Get metadata for multiple files/directories in parallel.

| Parameter | Type     | Required | Default | Description                       |
| --------- | -------- | -------- | ------- | --------------------------------- |
| `paths`   | string[] | Yes      | -       | Array of paths to query (max 100) |

Returns: Array of file info with individual success/error status, plus summary
(total, succeeded, failed).

---

### `grep`

Search for text content within files using regular expressions. Omit `path` to
search from the first allowed root.

| Parameter                | Type     | Required | Default               | Description                                                             |
| ------------------------ | -------- | -------- | --------------------- | ----------------------------------------------------------------------- |
| `path`                   | string   | No       | `first root`          | Base directory to search in (omit to use first root)                    |
| `pattern`                | string   | Yes      | -                     | Regex pattern to search for                                             |
| `filePattern`            | string   | No       | `**/*`                | Glob pattern to filter files                                            |
| `excludePatterns`        | string[] | No       | built-in exclude list | Glob patterns to exclude (overrides built-in list)                      |
| `caseSensitive`          | boolean  | No       | `false`               | Case-sensitive search                                                   |
| `maxResults`             | number   | No       | `100`                 | Maximum number of results                                               |
| `maxFileSize`            | number   | No       | 1MB                   | Maximum file size to scan (default from `MAX_SEARCH_SIZE`)              |
| `maxFilesScanned`        | number   | No       | `20000`               | Maximum files to scan before stopping                                   |
| `timeoutMs`              | number   | No       | `30000`               | Timeout in milliseconds                                                 |
| `skipBinary`             | boolean  | No       | `true`                | Skip likely-binary files                                                |
| `includeHidden`          | boolean  | No       | `false`               | Include hidden files and directories                                    |
| `includeIgnored`         | boolean  | No       | `false`               | Include ignored dirs (node_modules, dist) and disable built-in excludes |
| `contextLines`           | number   | No       | `0`                   | Lines of context before/after match (0-10)                              |
| `wholeWord`              | boolean  | No       | `false`               | Match whole words only                                                  |
| `isLiteral`              | boolean  | No       | `false`               | Treat pattern as literal string (escape regex chars)                    |
| `baseNameMatch`          | boolean  | No       | `false`               | Match file patterns without slashes against basenames                   |
| `caseSensitiveFileMatch` | boolean  | No       | `true`                | Case-sensitive filename matching                                        |

Returns: Matching lines with file path, line number, content, and optional
context. Structured output includes `ok`, `matches`, `totalMatches`, and
`truncated`.
Matched line content is trimmed to 200 characters.

---

Built-in exclude list (used by `grep` when `excludePatterns` is not provided and
`includeIgnored` is false) includes common dependency/build/output directories
and files: `node_modules`, `dist`, `build`, `coverage`, `.git`, `.vscode`,
`.idea`, `.DS_Store`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.cache`,
`.yarn`, `jspm_packages`, `bower_components`, `out`, `tmp`, `.temp`,
`npm-debug.log`, `yarn-debug.log`, `yarn-error.log`, `Thumbs.db`. Pass
`excludePatterns: []` or `includeIgnored: true` to disable it.

## Error Codes

| Code                    | Meaning                       |
| ----------------------- | ----------------------------- |
| `E_ACCESS_DENIED`       | Path outside allowed roots    |
| `E_NOT_FOUND`           | Path does not exist           |
| `E_NOT_FILE`            | Expected file, got directory  |
| `E_NOT_DIRECTORY`       | Expected directory, got file  |
| `E_TOO_LARGE`           | File exceeds size limits      |
| `E_TIMEOUT`             | Operation timed out           |
| `E_INVALID_PATTERN`     | Invalid glob/regex pattern    |
| `E_INVALID_INPUT`       | Invalid argument(s)           |
| `E_PERMISSION_DENIED`   | OS-level permission denied    |
| `E_SYMLINK_NOT_ALLOWED` | Symlink escapes allowed roots |
| `E_UNKNOWN`             | Unexpected error              |

## Client Configuration

<details>
<summary><b>VS Code</b></summary>

Add to `.vscode/mcp.json` (recommended) or `.vscode/settings.json`:

```json
{
  "servers": {
    "fs-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fs-context-mcp@latest", "${workspaceFolder}"]
    }
  }
}
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fs-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fs-context-mcp@latest", "C:\\path\\to\\project"]
    }
  }
}
```

If your client supports MCP Roots, you can omit the path. Otherwise, pass a path or `--allow-cwd`.

</details>

<details>
<summary><b>Cursor</b></summary>

Add to Cursor's MCP configuration:

```json
{
  "mcpServers": {
    "fs-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fs-context-mcp@latest", "${workspaceFolder}"]
    }
  }
}
```

</details>

<details>
<summary><b>Codex</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.fs-context]
command = "npx"
args = ["-y", "@j0hanz/fs-context-mcp@latest", "/path/to/your/project"]
```

If your client supports MCP Roots, you can omit the path. Otherwise, pass a path or `--allow-cwd`.

</details>

<details>
<summary><b>Windsurf</b></summary>

Add to Windsurf's MCP configuration:

```json
{
  "mcpServers": {
    "fs-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/fs-context-mcp@latest", "${workspaceFolder}"]
    }
  }
}
```

</details>

## Security

This server implements multiple layers of security:

| Protection                | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| Access control            | Only explicitly allowed directories are accessible            |
| Path validation           | All paths are validated before any filesystem operation       |
| Symlink protection        | Symlinks that resolve outside allowed directories are blocked |
| Path traversal prevention | Attempts to escape via `..` are detected and blocked          |
| Read-only operations      | No writes, deletes, or modifications                          |
| Safe regex                | Regex validation with RE2 prevents ReDoS                      |
| Size limits               | Configurable limits prevent resource exhaustion               |

## Development

### Prerequisites

- Node.js >= 20.0.0
- npm

### Scripts

| Command                 | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| `npm run build`         | Compile TypeScript to JavaScript                                   |
| `npm run dev`           | Watch mode with tsx                                                |
| `npm run start`         | Run compiled server                                                |
| `npm run test`          | Run tests (node --test with tsx/esm)                               |
| `npm run test:watch`    | Run tests in watch mode (node --test --watch)                      |
| `npm run test:coverage` | Run tests with coverage (node --test --experimental-test-coverage) |
| `npm run test:node`     | Run node-tests (isolated checks)                                   |
| `npm run lint`          | Run ESLint                                                         |
| `npm run format`        | Format code with Prettier                                          |
| `npm run type-check`    | TypeScript type checking                                           |
| `npm run inspector`     | Test with MCP Inspector                                            |

### Project Structure

```text
src/
  index.ts                 # CLI entry point
  server.ts                # MCP server wiring and roots handling
  tools.ts                 # MCP tool registration + response helpers
  schemas.ts               # Zod input/output schemas
  config.ts                # Shared types and formatting helpers
  instructions.md          # Tool usage instructions (bundled in dist)
  lib/                     # Core logic and filesystem operations
  __tests__/               # node:test + tsx tests
node-tests/                # Additional Node.js checks
docs/                      # Static docs assets
dist/                      # Build output (generated)
```

## Troubleshooting

| Issue                    | Solution                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| "Access denied" error    | Ensure the path is within an allowed directory. Use `roots` to check.        |
| "Path does not exist"    | Verify the path exists. Use `ls` to explore available files.                 |
| "File too large"         | Use `head` or increase `MAX_FILE_SIZE`.                                      |
| "Binary file" warning    | `read` only supports UTF-8 text and rejects binary files.                    |
| No directories available | Pass explicit paths, use `--allow-cwd`, or ensure the client provides Roots. |
| Symlink blocked          | Symlinks that resolve outside allowed directories are blocked.               |
| Invalid regex/pattern    | Simplify the regex or set `isLiteral=true` for exact matches.                |

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Run format, lint, type-check, build, and tests (`npm run format && npm run lint && npm run type-check && npm run build && npm run test`)
4. Commit your changes (`git commit -m 'Add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

### Code Style

- Use TypeScript with strict mode
- Follow ESLint configuration
- Use Prettier for formatting
- Write tests for new features
