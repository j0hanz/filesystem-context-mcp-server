# Filesystem Context MCP Server

<img src="docs/logo.png" alt="Filesystem Context MCP Server Logo" width="125">

A secure, read-only MCP server for filesystem scanning, searching, and analysis with comprehensive security validation.

[![npm version](https://img.shields.io/npm/v/@j0hanz/filesystem-context-mcp.svg)](https://www.npmjs.com/package/@j0hanz/filesystem-context-mcp)
[![License](https://img.shields.io/npm/l/@j0hanz/filesystem-context-mcp)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.25.1-purple)](https://modelcontextprotocol.io)

## One-Click Install

[![Install with NPX in VS Code](https://img.shields.io/badge/VS_Code-Install-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem-context&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-context-mcp%40latest%22%2C%22%24%7BworkspaceFolder%7D%22%5D%7D)[![Install with NPX in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=filesystem-context&inputs=%5B%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40j0hanz%2Ffilesystem-context-mcp%40latest%22%2C%22%24%7BworkspaceFolder%7D%22%5D%7D&quality=insiders)

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=filesystem-context&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBqMGhhbnovZmlsZXN5c3RlbS1jb250ZXh0LW1jcEBsYXRlc3QiLCIke3dvcmtzcGFjZUZvbGRlcn0iXX0=)

## Features

- Directory listing with recursive support
- Path search with glob patterns (files and directories)
- Content search with regex and context lines
- File reading with head/tail/line ranges
- Batch reads and metadata lookups in parallel
- Security: path validation, symlink escape protection, read-only operations

## When to Use

| Task                            | Tool                       |
| ------------------------------- | -------------------------- |
| Explore project structure       | `list_directory`           |
| Find files or directories       | `search_files`             |
| Search for code patterns/text   | `search_content`           |
| Read source code                | `read_file`                |
| Batch read multiple files       | `read_multiple_files`      |
| Get file metadata (size, dates) | `get_file_info`            |
| Batch get file metadata         | `get_multiple_file_info`   |
| Check available directories     | `list_allowed_directories` |

## Quick Start

### NPX (recommended)

Allow the current working directory explicitly:

```bash
npx -y @j0hanz/filesystem-context-mcp@latest --allow-cwd
```

Or pass explicit directories:

```bash
npx -y @j0hanz/filesystem-context-mcp@latest /path/to/project /path/to/docs
```

If your MCP client supports the Roots protocol, you can omit directory arguments and let the client provide allowed directories. Otherwise, pass explicit directories or use `--allow-cwd`.

### VS Code (workspace folder)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "${workspaceFolder}"
      ]
    }
  }
}
```

## Installation

### NPX (no install)

```bash
npx -y @j0hanz/filesystem-context-mcp@latest /path/to/dir1 /path/to/dir2
```

### Global installation

```bash
npm install -g @j0hanz/filesystem-context-mcp
filesystem-context-mcp /path/to/your/project
```

### From source

```bash
git clone https://github.com/j0hanz/filesystem-context-mcp-server.git
cd filesystem-context-mcp-server
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
4. If nothing is configured and the client provides no roots, the server has no access and logs a warning.

Notes:

- Windows drive-relative paths like `C:path` are rejected. Use `C:\path` or `C:/path`.
- Reserved Windows device names (e.g., `CON`, `NUL`) are blocked.

## Configuration

All configuration is optional. Values are integers unless noted. Sizes are in bytes, timeouts in milliseconds.

### Environment Variables

| Variable                         | Default                 | Range       | Description                                                                    |
| -------------------------------- | ----------------------- | ----------- | ------------------------------------------------------------------------------ |
| `UV_THREADPOOL_SIZE`             | (unset)                 | 1-1024      | libuv threadpool size. If set, caps parallelism.                               |
| `FILESYSTEM_CONTEXT_CONCURRENCY` | Auto (2x cores, cap 50) | 1-100       | Parallel file operations. Further capped by `UV_THREADPOOL_SIZE`               |
| `TRAVERSAL_JOBS`                 | 8                       | 1-50        | Reserved (currently unused; kept for compatibility)                            |
| `REGEX_TIMEOUT`                  | 100                     | 50-1000     | Reserved (currently unused; regex engine is RE2)                               |
| `MAX_FILE_SIZE`                  | 10MB                    | 1MB-100MB   | Max text file size (`read_file`, `read_multiple_files`)                        |
| `MAX_SEARCH_SIZE`                | 1MB                     | 100KB-10MB  | Max file size for content search (`search_content`)                            |
| `DEFAULT_DEPTH`                  | 10                      | 1-100       | Default max depth (`list_directory`, `search_files`)                           |
| `DEFAULT_RESULTS`                | 100                     | 10-10000    | Default max results (`search_files`, `search_content`)                         |
| `DEFAULT_LIST_MAX_ENTRIES`       | 10000                   | 100-100000  | Default max entries (`list_directory`)                                         |
| `DEFAULT_SEARCH_MAX_FILES`       | 20000                   | 100-100000  | Default max files scanned (`search_files`, `search_content`)                   |
| `DEFAULT_SEARCH_TIMEOUT`         | 30000                   | 100-3600000 | Default operation timeout (`list_directory`, `search_files`, `search_content`) |

See [CONFIGURATION.md](CONFIGURATION.md) for profiles and examples.

## Tools

All tools return both human-readable text and structured JSON. Structured
responses include `ok`, `error` (with `code`, `message`, `path`, `suggestion`),
and `effectiveOptions`/`summary` fields where applicable.

### `list_allowed_directories`

List all directories that this server can access.

| Parameter | Type | Required | Default | Description |
| --------- | ---- | -------- | ------- | ----------- |
| (none)    | -    | -        | -       | -           |

Returns: Allowed directory paths plus access status (accessible/readable),
count, and a configuration hint in structured output.

---

### `list_directory`

List contents of a directory with optional recursion.

| Parameter               | Type     | Required | Default | Description                                              |
| ----------------------- | -------- | -------- | ------- | -------------------------------------------------------- |
| `path`                  | string   | Yes      | -       | Directory path to list                                   |
| `recursive`             | boolean  | No       | `false` | List subdirectories recursively                          |
| `includeHidden`         | boolean  | No       | `false` | Include hidden files and directories                     |
| `excludePatterns`       | string[] | No       | `[]`    | Glob patterns to exclude                                 |
| `pattern`               | string   | No       | -       | Glob pattern to include (relative, no `..`)              |
| `maxDepth`              | number   | No       | `10`    | Maximum depth for recursive listing (0-100)              |
| `maxEntries`            | number   | No       | `10000` | Maximum entries to return (1-100000)                     |
| `timeoutMs`             | number   | No       | `30000` | Timeout in milliseconds                                  |
| `sortBy`                | string   | No       | `name`  | Sort by: `name`, `size`, `modified`, `type`              |
| `includeSymlinkTargets` | boolean  | No       | `false` | Include symlink target paths (symlinks are not followed) |

Returns: Entries with name, relativePath, type, extension, size, modified time,
and symlink target. Structured output includes `effectiveOptions` and a
`summary` (totals, maxDepthReached, truncated/stoppedReason, entriesScanned,
entriesVisible, skippedInaccessible, symlinksNotFollowed).

---

### `search_files`

Search for paths (files and directories) using glob patterns.

| Parameter         | Type     | Required | Default               | Description                                                  |
| ----------------- | -------- | -------- | --------------------- | ------------------------------------------------------------ |
| `path`            | string   | Yes      | -                     | Base directory to search from                                |
| `pattern`         | string   | Yes      | -                     | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`)                |
| `excludePatterns` | string[] | No       | built-in exclude list | Glob patterns to exclude                                     |
| `maxResults`      | number   | No       | `100`                 | Maximum matches to return (1-10000)                          |
| `sortBy`          | string   | No       | `path`                | Sort by: `name`, `size`, `modified`, `path`                  |
| `maxDepth`        | number   | No       | `10`                  | Maximum directory depth to search (0-100)                    |
| `maxFilesScanned` | number   | No       | `20000`               | Maximum files to scan before stopping                        |
| `timeoutMs`       | number   | No       | `30000`               | Timeout in milliseconds                                      |
| `baseNameMatch`   | boolean  | No       | `false`               | Match patterns without slashes against basenames             |
| `skipSymlinks`    | boolean  | No       | `true`                | Must remain true; symlink traversal is disabled for security |
| `includeHidden`   | boolean  | No       | `false`               | Include hidden files and directories                         |

Returns: Matching paths with relative path, type, size, and modified date.
Structured output includes `effectiveOptions` and a `summary` (matched,
filesScanned, truncated/stoppedReason, skippedInaccessible).
Directories may appear as type `other` in structured output.

---

### `read_file`

Read the contents of a text file.

| Parameter    | Type    | Required | Default | Description                                                         |
| ------------ | ------- | -------- | ------- | ------------------------------------------------------------------- |
| `path`       | string  | Yes      | -       | File path to read                                                   |
| `encoding`   | string  | No       | `utf-8` | File encoding (`utf-8`, `utf8`, `ascii`, `base64`, `hex`, `latin1`) |
| `maxSize`    | number  | No       | 10MB    | Maximum file size in bytes (capped by `MAX_FILE_SIZE`)              |
| `skipBinary` | boolean | No       | `true`  | Reject likely-binary files                                          |
| `lineStart`  | number  | No       | -       | Start line (1-indexed) for range reading                            |
| `lineEnd`    | number  | No       | -       | End line (inclusive) for range reading                              |
| `head`       | number  | No       | -       | Read only first N lines                                             |
| `tail`       | number  | No       | -       | Read only last N lines                                              |

Notes:

- `head`, `tail`, and `lineStart/lineEnd` are mutually exclusive.
- `lineStart` and `lineEnd` must be provided together.

Returns: File content plus structured metadata (readMode, linesRead,
totalLines, hasMoreLines, truncated, effectiveOptions).

---

### `read_multiple_files`

Read multiple files in parallel.

| Parameter      | Type     | Required | Default | Description                                                |
| -------------- | -------- | -------- | ------- | ---------------------------------------------------------- |
| `paths`        | string[] | Yes      | -       | Array of file paths (max 100)                              |
| `encoding`     | string   | No       | `utf-8` | File encoding                                              |
| `maxSize`      | number   | No       | 10MB    | Maximum size per file in bytes (capped by `MAX_FILE_SIZE`) |
| `maxTotalSize` | number   | No       | 100MB   | Maximum total size across all files (max 1GB)              |
| `head`         | number   | No       | -       | Read only first N lines of each file                       |
| `tail`         | number   | No       | -       | Read only last N lines of each file                        |
| `lineStart`    | number   | No       | -       | Start line (1-indexed) for each file                       |
| `lineEnd`      | number   | No       | -       | End line (inclusive) for each file                         |

Notes:

- `lineStart` and `lineEnd` must be provided together.
- `head`, `tail`, and `lineStart/lineEnd` are mutually exclusive.
- No binary detection is performed; use `read_file` with `skipBinary=true` for checks.

Returns: Per-file content or error, plus structured summary and
effectiveOptions.

---

### `get_file_info`

Get detailed metadata about a file or directory.

| Parameter | Type   | Required | Default | Description               |
| --------- | ------ | -------- | ------- | ------------------------- |
| `path`    | string | Yes      | -       | Path to file or directory |

Returns: name, path, type, size, created/modified/accessed timestamps,
permissions, isHidden, MIME type, and symlink target (if applicable).

---

### `get_multiple_file_info`

Get metadata for multiple files/directories in parallel.

| Parameter         | Type     | Required | Default | Description                       |
| ----------------- | -------- | -------- | ------- | --------------------------------- |
| `paths`           | string[] | Yes      | -       | Array of paths to query (max 100) |
| `includeMimeType` | boolean  | No       | `true`  | Include MIME type detection       |

Returns: Array of file info with individual success/error status, plus summary
(total, succeeded, failed, totalSize).

---

### `search_content`

Search for text content within files using regular expressions.

| Parameter                | Type     | Required | Default               | Description                                                |
| ------------------------ | -------- | -------- | --------------------- | ---------------------------------------------------------- |
| `path`                   | string   | Yes      | -                     | Base directory to search in                                |
| `pattern`                | string   | Yes      | -                     | Regex pattern to search for                                |
| `filePattern`            | string   | No       | `**/*`                | Glob pattern to filter files                               |
| `excludePatterns`        | string[] | No       | built-in exclude list | Glob patterns to exclude                                   |
| `caseSensitive`          | boolean  | No       | `false`               | Case-sensitive search                                      |
| `maxResults`             | number   | No       | `100`                 | Maximum number of results                                  |
| `maxFileSize`            | number   | No       | 1MB                   | Maximum file size to scan (default from `MAX_SEARCH_SIZE`) |
| `maxFilesScanned`        | number   | No       | `20000`               | Maximum files to scan before stopping                      |
| `timeoutMs`              | number   | No       | `30000`               | Timeout in milliseconds                                    |
| `skipBinary`             | boolean  | No       | `true`                | Skip likely-binary files                                   |
| `includeHidden`          | boolean  | No       | `false`               | Include hidden files and directories                       |
| `contextLines`           | number   | No       | `0`                   | Lines of context before/after match (0-10)                 |
| `wholeWord`              | boolean  | No       | `false`               | Match whole words only                                     |
| `isLiteral`              | boolean  | No       | `false`               | Treat pattern as literal string (escape regex chars)       |
| `baseNameMatch`          | boolean  | No       | `false`               | Match file patterns without slashes against basenames      |
| `caseSensitiveFileMatch` | boolean  | No       | `true`                | Case-sensitive filename matching                           |

Returns: Matching lines with file path, line number, content, and optional
context. Structured output includes `effectiveOptions` and a `summary`
(filesScanned/filesMatched, totalMatches, truncated/stoppedReason,
skippedTooLarge/skippedBinary/skippedInaccessible,
linesSkippedDueToRegexTimeout).
Matched line content is trimmed to 200 characters.

---

Built-in exclude list includes common dependency/build/output directories and
files: `node_modules`, `dist`, `build`, `coverage`, `.git`, `.vscode`, `.idea`,
`.DS_Store`, `.next`, `.nuxt`, `.output`, `.svelte-kit`, `.cache`, `.yarn`,
`jspm_packages`, `bower_components`, `out`, `tmp`, `.temp`,
`npm-debug.log`, `yarn-debug.log`, `yarn-error.log`, `Thumbs.db`. Pass
`excludePatterns: []` to disable it.

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
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "${workspaceFolder}"
      ]
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
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "C:\\path\\to\\project"
      ]
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
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "${workspaceFolder}"
      ]
    }
  }
}
```

</details>

<details>
<summary><b>Codex</b></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.filesystem-context]
command = "npx"
args = ["-y", "@j0hanz/filesystem-context-mcp@latest", "/path/to/your/project"]
```

If your client supports MCP Roots, you can omit the path. Otherwise, pass a path or `--allow-cwd`.

</details>

<details>
<summary><b>Windsurf</b></summary>

Add to Windsurf's MCP configuration:

```json
{
  "mcpServers": {
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "${workspaceFolder}"
      ]
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

| Command                 | Description                      |
| ----------------------- | -------------------------------- |
| `npm run build`         | Compile TypeScript to JavaScript |
| `npm run dev`           | Watch mode with tsx              |
| `npm run start`         | Run compiled server              |
| `npm run test`          | Run tests with Vitest            |
| `npm run test:watch`    | Run tests in watch mode          |
| `npm run test:coverage` | Run tests with coverage report   |
| `npm run lint`          | Run ESLint                       |
| `npm run format`        | Format code with Prettier        |
| `npm run type-check`    | TypeScript type checking         |
| `npm run bench`         | Run benchmarks                   |
| `npm run inspector`     | Test with MCP Inspector          |

### Project Structure

```text
src/
  index.ts                 # CLI entry point
  server.ts                # MCP server wiring and roots handling
  instructions.md          # Tool usage instructions (bundled in dist)
  config/                  # Shared types and formatting helpers
  lib/                     # Core logic and filesystem operations
  schemas/                 # Zod input/output schemas
  tools/                   # MCP tool registration
  __tests__/               # Vitest tests
```

## Troubleshooting

| Issue                    | Solution                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| "Access denied" error    | Ensure the path is within an allowed directory. Use `list_allowed_directories` to check. |
| "Path does not exist"    | Verify the path exists. Use `list_directory` to explore available files.                 |
| "File too large"         | Use `head`/`tail` or increase `maxSize`.                                                 |
| "Binary file" warning    | Set `skipBinary=false` in `read_file` to read as text.                                   |
| No directories available | Pass explicit paths, use `--allow-cwd`, or ensure the client provides MCP Roots.         |
| Symlink blocked          | Symlinks that resolve outside allowed directories are blocked.                           |
| Invalid regex/pattern    | Simplify the regex or set `isLiteral=true` for exact matches.                            |

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests and linting (`npm run lint && npm run test`)
4. Commit your changes (`git commit -m 'Add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

### Code Style

- Use TypeScript with strict mode
- Follow ESLint configuration
- Use Prettier for formatting
- Write tests for new features
