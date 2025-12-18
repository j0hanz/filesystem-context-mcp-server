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

## ✨ Features

| Feature                    | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| 📂 **Directory Listing**   | List and explore directory contents with recursive support             |
| 🔍 **File Search**         | Find files using glob patterns like `**/*.ts`                          |
| 📝 **Content Search**      | Search text within files using regex with context lines                |
| 📊 **Directory Analysis**  | Get statistics, file types, largest files, and recently modified files |
| 🌳 **Directory Tree**      | JSON tree structure optimized for AI parsing                           |
| 📄 **File Reading**        | Read single or multiple files with head/tail and line range support    |
| 🖼️ **Media File Support**  | Read binary files (images, audio, video) as base64                     |
| 🔒 **Security First**      | Path validation, symlink escape protection, and access control         |
| ⚡ **Parallel Operations** | Efficient batch file reading with configurable concurrency             |

## 🎯 When to Use

| Task                             | Tool                       |
| -------------------------------- | -------------------------- |
| Explore project structure        | `list_directory`           |
| Find specific file types         | `search_files`             |
| Search for code patterns/text    | `search_content`           |
| Understand codebase statistics   | `analyze_directory`        |
| Get AI-friendly project overview | `directory_tree`           |
| Read source code                 | `read_file`                |
| Batch read multiple files        | `read_multiple_files`      |
| Get file metadata (size, dates)  | `get_file_info`            |
| Read images or binary files      | `read_media_file`          |
| Check available directories      | `list_allowed_directories` |

## 🚀 Quick Start

### NPX (Recommended - Zero Config)

```bash
# Works in current directory automatically!
npx -y @j0hanz/filesystem-context-mcp@latest
```

Or specify directories explicitly:

```bash
npx -y @j0hanz/filesystem-context-mcp@latest /path/to/your/project
```

### VS Code (with workspace folder)

Add to your VS Code settings (`.vscode/mcp.json`):

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

> **Tip:** `${workspaceFolder}` automatically uses your current VS Code workspace. You can also omit it and the server will use its current working directory.

### Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "filesystem-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-context-mcp@latest"]
    }
  }
}
```

> **Note:** Claude Desktop will use the current working directory automatically. No path arguments needed!

## 📦 Installation

### NPX (No Installation)

```bash
npx -y @j0hanz/filesystem-context-mcp@latest /path/to/dir1 /path/to/dir2
```

### Global Installation

```bash
npm install -g @j0hanz/filesystem-context-mcp
filesystem-context-mcp /path/to/your/project
```

### From Source

```bash
git clone https://github.com/j0hanz/filesystem-context-mcp-server.git
cd filesystem-context-mcp-server
npm install
npm run build
node dist/index.js /path/to/your/project
```

## ⚙️ Configuration

### Directory Resolution (Priority Order)

The server determines which directories to access in this order:

1. **CLI Arguments** - Explicitly passed paths take highest priority
2. **MCP Roots Protocol** - Directories provided by the MCP client
3. **Current Working Directory** - Automatic fallback for plug-and-play experience

This means you can run the server with zero configuration and it will work!

### Command Line Arguments

Optionally specify one or more directory paths as arguments:

```bash
filesystem-context-mcp /home/user/project /home/user/docs
```

### MCP Roots Protocol

If no CLI arguments are provided, the server will use the MCP Roots protocol to receive allowed directories from the client (if supported).

### Zero-Config Mode

If neither CLI arguments nor MCP Roots provide directories, the server automatically uses the current working directory. This makes it truly plug-and-play!

### Environment Variables

All configuration values have sensible defaults and are optional. Only configure if you need to tune performance or resource usage.

| Variable          | Default | Range      | Description                           |
| ----------------- | ------- | ---------- | ------------------------------------- |
| `PARALLEL_JOBS`   | 20      | 1-100      | Maximum parallel file operations      |
| `TRAVERSAL_JOBS`  | 8       | 1-50       | Directory traversal concurrency       |
| `REGEX_TIMEOUT`   | 100     | 50-1000    | Regex matching timeout (milliseconds) |
| `MAX_FILE_SIZE`   | 10MB    | 1MB-100MB  | Maximum text file size (bytes)        |
| `MAX_MEDIA_SIZE`  | 50MB    | 1MB-500MB  | Maximum media file size (bytes)       |
| `MAX_SEARCH_SIZE` | 1MB     | 100KB-10MB | Maximum file size for content search  |
| `DEFAULT_DEPTH`   | 10      | 1-100      | Default maximum recursion depth       |
| `DEFAULT_RESULTS` | 100     | 10-10000   | Default maximum search results        |
| `DEFAULT_TOP`     | 10      | 1-1000     | Default top N items in analysis       |
| `DEFAULT_TREE`    | 5       | 1-50       | Default directory tree depth          |

> **💡 Tip:** See [CONFIGURATION.md](CONFIGURATION.md) for detailed environment variable usage examples, configuration profiles, and best practices for different use cases.

## 🔧 Tools

### `list_allowed_directories`

List all directories that this server is allowed to access.

| Parameter | Type | Required | Default | Description            |
| --------- | ---- | -------- | ------- | ---------------------- |
| _(none)_  | -    | -        | -       | No parameters required |

**Returns:** Array of allowed directory paths.

---

### `list_directory`

List contents of a directory with optional recursive listing.

| Parameter               | Type    | Required | Default | Description                                 |
| ----------------------- | ------- | -------- | ------- | ------------------------------------------- |
| `path`                  | string  | ✅       | -       | Directory path to list                      |
| `recursive`             | boolean | ❌       | `false` | List recursively                            |
| `includeHidden`         | boolean | ❌       | `false` | Include hidden files                        |
| `maxDepth`              | number  | ❌       | `10`    | Maximum depth for recursive listing (0-100) |
| `maxEntries`            | number  | ❌       | -       | Maximum entries to return (1-100,000)       |
| `sortBy`                | string  | ❌       | `name`  | Sort by: `name`, `size`, `modified`, `type` |
| `includeSymlinkTargets` | boolean | ❌       | `false` | Include symlink target paths                |

**Returns:** List of entries with name, type, size, and modified date.

---

### `search_files`

Search for files using glob patterns.

| Parameter         | Type     | Required | Default | Description                                   |
| ----------------- | -------- | -------- | ------- | --------------------------------------------- |
| `path`            | string   | ✅       | -       | Base directory to search from                 |
| `pattern`         | string   | ✅       | -       | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`) |
| `excludePatterns` | string[] | ❌       | `[]`    | Patterns to exclude                           |
| `maxResults`      | number   | ❌       | -       | Maximum matches to return (max 10,000)        |
| `sortBy`          | string   | ❌       | `path`  | Sort by: `name`, `size`, `modified`, `path`   |
| `maxDepth`        | number   | ❌       | -       | Maximum directory depth to search (1-100)     |

**Returns:** List of matching files with path, type, size, and modified date.

**Example:**

```json
{
  "path": "/project",
  "pattern": "**/*.ts",
  "excludePatterns": ["node_modules/**", "dist/**"]
}
```

---

### `read_file`

Read the contents of a text file.

| Parameter   | Type   | Required | Default | Description                                                |
| ----------- | ------ | -------- | ------- | ---------------------------------------------------------- |
| `path`      | string | ✅       | -       | File path to read                                          |
| `encoding`  | string | ❌       | `utf-8` | File encoding (`utf-8`, `ascii`, `base64`, etc.)           |
| `maxSize`   | number | ❌       | 10MB    | Maximum file size in bytes                                 |
| `lineStart` | number | ❌       | -       | Start line (1-indexed, min 1) for reading a range          |
| `lineEnd`   | number | ❌       | -       | End line (1-indexed, inclusive, min 1) for reading a range |
| `head`      | number | ❌       | -       | Read only first N lines                                    |
| `tail`      | number | ❌       | -       | Read only last N lines                                     |

> **Note:** Cannot specify both `head` and `tail` simultaneously. Use `lineStart`/`lineEnd` for range reading.

**Returns:** File contents as text.

---

### `read_multiple_files`

Read multiple files in parallel for efficient batch operations.

| Parameter  | Type     | Required | Default | Description                          |
| ---------- | -------- | -------- | ------- | ------------------------------------ |
| `paths`    | string[] | ✅       | -       | Array of file paths (max 100)        |
| `encoding` | string   | ❌       | `utf-8` | File encoding                        |
| `maxSize`  | number   | ❌       | 10MB    | Maximum file size per file           |
| `head`     | number   | ❌       | -       | Read only first N lines of each file |
| `tail`     | number   | ❌       | -       | Read only last N lines of each file  |

**Returns:** Array of results with content or error for each file.

---

### `get_file_info`

Get detailed metadata about a file or directory.

| Parameter | Type   | Required | Default | Description               |
| --------- | ------ | -------- | ------- | ------------------------- |
| `path`    | string | ✅       | -       | Path to file or directory |

**Returns:** Metadata including name, type, size, created/modified/accessed timestamps, permissions, MIME type, and symlink target (if applicable).

---

### `search_content`

Search for text content within files using regular expressions.

| Parameter         | Type     | Required | Default | Description                                      |
| ----------------- | -------- | -------- | ------- | ------------------------------------------------ |
| `path`            | string   | ✅       | -       | Base directory to search in                      |
| `pattern`         | string   | ✅       | -       | Regex pattern to search for                      |
| `filePattern`     | string   | ❌       | `**/*`  | Glob pattern to filter files                     |
| `excludePatterns` | string[] | ❌       | `[]`    | Glob patterns to exclude                         |
| `caseSensitive`   | boolean  | ❌       | `false` | Case-sensitive search                            |
| `maxResults`      | number   | ❌       | `100`   | Maximum number of results (1-10,000)             |
| `maxFileSize`     | number   | ❌       | 1MB     | Maximum file size to scan                        |
| `maxFilesScanned` | number   | ❌       | -       | Maximum files to scan before stopping            |
| `timeoutMs`       | number   | ❌       | -       | Timeout in milliseconds (100-3,600,000)          |
| `skipBinary`      | boolean  | ❌       | `true`  | Skip binary files                                |
| `contextLines`    | number   | ❌       | `0`     | Lines of context before/after match (0-10)       |
| `wholeWord`       | boolean  | ❌       | `false` | Match whole words only                           |
| `isLiteral`       | boolean  | ❌       | `false` | Treat pattern as literal string (escape special) |

**Returns:** Matching lines with file path, line number, content, and optional context.

**Example:**

```json
{
  "path": "/project/src",
  "pattern": "TODO|FIXME",
  "filePattern": "**/*.ts",
  "contextLines": 2
}
```

---

### `analyze_directory`

Analyze a directory structure and return statistics.

| Parameter         | Type     | Required | Default | Description                              |
| ----------------- | -------- | -------- | ------- | ---------------------------------------- |
| `path`            | string   | ✅       | -       | Directory to analyze                     |
| `maxDepth`        | number   | ❌       | `10`    | Maximum depth to analyze (0-100)         |
| `topN`            | number   | ❌       | `10`    | Number of top items to return (max 1000) |
| `excludePatterns` | string[] | ❌       | `[]`    | Glob patterns to exclude                 |
| `includeHidden`   | boolean  | ❌       | `false` | Include hidden files and directories     |

**Returns:** Statistics including total files/directories, total size, file type distribution, largest files, and recently modified files.

---

### `directory_tree`

Get a JSON tree structure of a directory, optimized for AI parsing.

| Parameter         | Type     | Required | Default | Description                                  |
| ----------------- | -------- | -------- | ------- | -------------------------------------------- |
| `path`            | string   | ✅       | -       | Directory path to build tree from            |
| `maxDepth`        | number   | ❌       | `5`     | Maximum depth to traverse (0-50)             |
| `excludePatterns` | string[] | ❌       | `[]`    | Glob patterns to exclude                     |
| `includeHidden`   | boolean  | ❌       | `false` | Include hidden files and directories         |
| `includeSize`     | boolean  | ❌       | `false` | Include file sizes in the tree               |
| `maxFiles`        | number   | ❌       | -       | Maximum total files to include (max 100,000) |

**Returns:** Hierarchical tree structure with file/directory nodes.

---

### `read_media_file`

Read a binary/media file and return it as base64-encoded data.

| Parameter | Type   | Required | Default | Description                            |
| --------- | ------ | -------- | ------- | -------------------------------------- |
| `path`    | string | ✅       | -       | Path to the media file                 |
| `maxSize` | number | ❌       | 50MB    | Maximum file size in bytes (max 500MB) |

**Supported formats:** Images (PNG, JPG, GIF, WebP, SVG, etc.), Audio (MP3, WAV, FLAC, etc.), Video (MP4, WebM, etc.), Fonts (TTF, WOFF, etc.), PDFs, and more.

**Returns:** Base64-encoded data with MIME type, size, and dimensions (for images).

## 🔌 Client Configuration

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

> **Note:** `${workspaceFolder}` is expanded by VS Code to the current workspace path.

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
      "args": ["-y", "@j0hanz/filesystem-context-mcp@latest"]
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

Add to Cursor's MCP configuration:

```json
{
  "mcpServers": {
    "filesystem-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-context-mcp@latest"]
    }
  }
}
```

</details>

<details>
<summary><b>Codex</b></summary>

Add to `~/.codex/config.toml`:

**Basic Configuration (auto-detects current directory):**

```toml
[mcp_servers.filesystem-context]
command = "npx"
args = ["-y", "@j0hanz/filesystem-context-mcp@latest"]
```

**Configuration with Explicit Directory:**

```toml
[mcp_servers.filesystem-context]
command = "npx"
args = ["-y", "@j0hanz/filesystem-context-mcp@latest", "/path/to/your/project"]
```

**Configuration with Multiple Directories:**

```toml
[mcp_servers.filesystem-context]
command = "npx"
args = ["-y", "@j0hanz/filesystem-context-mcp@latest", "/path/to/project1", "/path/to/project2"]
```

> **Note:** You can access the config file via Codex IDE by clicking the gear icon → "Codex Settings > Open config.toml". If no directories are specified, it will use the current working directory automatically.

</details>

<details>
<summary><b>Windsurf</b></summary>

Add to Windsurf's MCP configuration:

```json
{
  "mcpServers": {
    "filesystem-context": {
      "command": "npx",
      "args": ["-y", "@j0hanz/filesystem-context-mcp@latest"]
    }
  }
}
```

</details>

## 🔒 Security

This server implements multiple layers of security:

| Protection                    | Description                                                               |
| ----------------------------- | ------------------------------------------------------------------------- |
| **Access Control**            | Only explicitly allowed directories are accessible                        |
| **Path Validation**           | All paths are validated before any filesystem operation                   |
| **Symlink Protection**        | Symlinks that resolve outside allowed directories are blocked             |
| **Path Traversal Prevention** | Attempts to escape via `../` are detected and blocked                     |
| **Read-Only Operations**      | Server only performs read operations—no writes, deletes, or modifications |
| **Safe Regex**                | Regular expressions are validated to prevent ReDoS attacks                |
| **Size Limits**               | Configurable limits prevent resource exhaustion                           |

### Security Model

```text
┌─────────────────────────────────────────────────────────┐
│                    MCP Client                           │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│            Filesystem Context MCP Server                │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Path Validation Layer                │  │
│  │  • Normalize paths                                │  │
│  │  • Check against allowed directories              │  │
│  │  • Resolve and validate symlinks                  │  │
│  │  • Block traversal attempts                       │  │
│  └───────────────────────────────────────────────────┘  │
│                         │                               │
│                         ▼                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │            Read-Only File Operations              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│              Allowed Directories Only                   │
│  /home/user/project  ✅                                 │
│  /home/user/docs     ✅                                 │
│  /etc/passwd         ❌ (blocked)                       │
│  ../../../etc        ❌ (blocked)                       │
└─────────────────────────────────────────────────────────┘
```

## 🛠️ Development

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
| `npm run inspector`     | Test with MCP Inspector          |

### Project Structure

```text
src/
├── index.ts              # Entry point, CLI argument parsing
├── server.ts             # MCP server setup, roots protocol handling
├── instructions.md       # AI instructions for tool usage (bundled with dist)
├── config/
│   └── types.ts          # Shared TypeScript types
├── lib/
│   ├── constants.ts      # Configuration constants and limits
│   ├── errors.ts         # Error handling utilities
│   ├── file-operations.ts# Core filesystem operations
│   ├── formatters.ts     # Output formatting utilities
│   ├── fs-helpers.ts     # Low-level filesystem helpers
│   ├── image-parsing.ts  # Image dimension parsing
│   ├── path-utils.ts     # Path manipulation utilities
│   └── path-validation.ts# Security: path validation layer
├── schemas/
│   ├── common.ts         # Shared Zod schemas
│   ├── inputs.ts         # Input validation schemas
│   ├── outputs.ts        # Output validation schemas
│   ├── validators.ts     # Custom validation functions
│   └── index.ts          # Schema exports
├── tools/
│   ├── analyze-directory.ts
│   ├── directory-tree.ts
│   ├── get-file-info.ts
│   ├── list-allowed-dirs.ts
│   ├── list-directory.ts
│   ├── read-file.ts
│   ├── read-media-file.ts
│   ├── read-multiple-files.ts
│   ├── search-content.ts
│   ├── search-files.ts
│   └── index.ts          # Tool registration
└── __tests__/            # Test files
```

### Testing with MCP Inspector

```bash
npm run inspector
```

This launches the MCP Inspector for interactive testing of all tools.

## ❓ Troubleshooting

| Issue                       | Solution                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| "Access denied" error       | Ensure the path is within an allowed directory. Use `list_allowed_directories` to check. |
| "Path does not exist" error | Verify the path exists. Use `list_directory` to explore available files.                 |
| "File too large" error      | Use `head` or `tail` parameters for partial reading, or increase `maxSize`.              |
| "Binary file" warning       | Use `read_media_file` for binary files, or set `skipBinary=false` in content search.     |
| Unexpected directory access | Server defaults to CWD if no args/roots provided. Pass explicit paths to restrict.       |
| Symlink blocked             | Symlinks that resolve outside allowed directories are blocked for security.              |
| Regex timeout               | Simplify the regex pattern or use `isLiteral=true` for literal string search.            |

## 🤝 Contributing

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
