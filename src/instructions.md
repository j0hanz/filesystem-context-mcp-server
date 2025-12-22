# Filesystem Context MCP Server

> **Read-only** tools for exploring directories, searching files, and analyzing codebases via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

This server enables AI assistants to safely explore and analyze filesystem contents without modification capabilities. All operations are sandboxed to explicitly allowed directories.

---

## Quick Reference

| Goal                | Tool                       | Key Parameters                          |
| ------------------- | -------------------------- | --------------------------------------- |
| Check access        | `list_allowed_directories` | —                                       |
| Project structure   | `directory_tree`           | `maxDepth`, `excludePatterns`           |
| List contents       | `list_directory`           | `recursive`, `sortBy`                   |
| Directory stats     | `analyze_directory`        | `topN`, `excludePatterns`, `maxEntries` |
| Find files          | `search_files`             | `pattern` (glob), `maxResults`          |
| Search in files     | `search_content`           | `pattern` (regex), `contextLines`       |
| Find definitions    | `search_definitions`       | `name`, `type`, `contextLines`          |
| Read file           | `read_file`                | `head`, `tail`, `lineStart/lineEnd`     |
| Read multiple files | `read_multiple_files`      | `paths[]` — **preferred for 2+**        |
| File metadata       | `get_file_info`            | `path`                                  |
| Batch file metadata | `get_multiple_file_info`   | `paths[]` — **preferred for 2+**        |
| Compute checksums   | `compute_checksums`        | `paths[]`, `algorithm`                  |
| Binary/media files  | `read_media_file`          | `maxSize`                               |

---

## Workflows

### Project Discovery

```text
list_allowed_directories → directory_tree(maxDepth=3) → analyze_directory → read_multiple_files([package.json, README.md])
```

### Find & Read Code

```text
search_files(pattern="**/*.ts") → read_multiple_files([...results])
```

### Search Patterns

```text
search_content(pattern="TODO|FIXME", filePattern="**/*.ts", contextLines=2)
```

### Find Code Definitions

```text
search_definitions(path="src/", name="User") → Find classes/functions/types named "User"
search_definitions(path="src/", type="interface") → Discover all interfaces
```

### Common Glob Patterns

| Pattern               | Matches                                   |
| --------------------- | ----------------------------------------- |
| `**/*.ts`             | All TypeScript files                      |
| `src/**/*.{js,jsx}`   | JS/JSX files under `src/`                 |
| `**/test/**`          | All files in any `test/` directory        |
| `**/*.test.ts`        | Test files by naming convention           |
| `!**/node_modules/**` | Exclude `node_modules/` (use in excludes) |

---

## Best Practices

**Do:**

- Use `read_multiple_files` for 2+ files (parallel, resilient)
- Set `maxResults`, `maxDepth`, `maxEntries` limits
- Use `excludePatterns=["node_modules", ".git", "dist"]`
- Preview with `head=50` before full reads

**Don't:**

- Loop `read_file` — batch with `read_multiple_files`
- Recursive search without `maxDepth`
- Search without `maxResults` on large codebases

## Tool Details

### `directory_tree`

JSON tree structure for AI parsing.

| Parameter         | Default | Description           |
| ----------------- | ------- | --------------------- |
| `path`            | —       | Directory path        |
| `maxDepth`        | 5       | Depth limit (0-50)    |
| `excludePatterns` | []      | Glob patterns to skip |
| `includeHidden`   | false   | Include dotfiles      |
| `includeSize`     | false   | Show file sizes       |
| `maxFiles`        | —       | Limit total files     |

### `search_files`

Find files (not directories) by glob pattern.

| Parameter         | Default | Description               |
| ----------------- | ------- | ------------------------- |
| `path`            | -       | Base directory            |
| `pattern`         | -       | Glob: `**/*.ts`, `src/**` |
| `excludePatterns` | []      | Patterns to skip          |
| `maxResults`      | -       | Limit (up to 10,000)      |
| `sortBy`          | "path"  | `name/size/modified/path` |
| `includeHidden`   | false   | Include dotfiles          |

### `search_content`

Grep-like regex search in files.

| Parameter       | Default | Description               |
| --------------- | ------- | ------------------------- |
| `path`          | —       | Base directory            |
| `pattern`       | —       | Regex: `TODO\|FIXME`      |
| `filePattern`   | `**/*`  | Glob filter               |
| `contextLines`  | 0       | Lines before/after (0-10) |
| `caseSensitive` | false   | Case matching             |
| `wholeWord`     | false   | Word boundaries           |
| `isLiteral`     | false   | Escape regex              |
| `maxResults`    | 100     | Limit matches             |
| `skipBinary`    | true    | Skip binary files         |

### `search_definitions`

Find code definitions (classes, functions, interfaces, types, enums, variables) without manual regex construction.

| Parameter         | Default | Description                                                                   |
| ----------------- | ------- | ----------------------------------------------------------------------------- |
| `path`            | -       | Base directory to search                                                      |
| `name`            | -       | Definition name to find                                                       |
| `type`            | -       | Definition type: `class`, `function`, `interface`, `type`, `enum`, `variable` |
| `caseSensitive`   | true    | Case-sensitive name matching                                                  |
| `maxResults`      | 100     | Limit matches                                                                 |
| `excludePatterns` | []      | Glob patterns to exclude                                                      |
| `includeHidden`   | false   | Include hidden files and directories                                          |
| `contextLines`    | 0       | Lines of context before/after match (0-10)                                    |

**Usage patterns:**

- **Find by name:** `search_definitions(path="src/", name="UserService")` — finds class/function/type named UserService
- **Discovery mode:** `search_definitions(path="src/", type="interface")` — lists all interfaces
- **Combined:** `search_definitions(path="src/", name="Handler", type="class")` — finds classes named "Handler"

### `read_file`

Read single file with line selection.

| Parameter    | Default | Description                                         |
| ------------ | ------- | --------------------------------------------------- |
| `path`       | -       | File path                                           |
| `encoding`   | utf-8   | `utf-8/ascii/base64/hex/latin1`                     |
| `maxSize`    | 10MB    | Size limit                                          |
| `skipBinary` | false   | Reject binary files (use `read_media_file` instead) |
| `head`       | -       | First N lines                                       |
| `tail`       | -       | Last N lines                                        |
| `lineStart`  | -       | Start line (1-indexed)                              |
| `lineEnd`    | -       | End line (inclusive)                                |

> ⚠️ Cannot combine `head/tail` with `lineStart/lineEnd`

### `read_multiple_files`

Parallel batch reads - failures don't block others.

| Parameter   | Default | Description                     |
| ----------- | ------- | ------------------------------- |
| `paths`     | -       | Array (max 100)                 |
| `encoding`  | utf-8   | Encoding for all                |
| `maxSize`   | 10MB    | Per-file limit                  |
| `head`      | -       | First N lines each              |
| `tail`      | -       | Last N lines each               |
| `lineStart` | -       | Start line (1-indexed) per file |
| `lineEnd`   | -       | End line (inclusive) per file   |

> ⚠️ Cannot combine `head/tail` with `lineStart/lineEnd`

### `list_directory`

Flat listing with metadata.

| Parameter         | Default | Description               |
| ----------------- | ------- | ------------------------- |
| `path`            | -       | Directory path            |
| `recursive`       | false   | Include subdirs           |
| `excludePatterns` | []      | Patterns to skip          |
| `pattern`         | -       | Glob to include           |
| `sortBy`          | "name"  | `name/size/modified/type` |
| `maxDepth`        | 10      | Depth when recursive      |
| `maxEntries`      | 10000   | Limit (up to 100,000)     |

**Structured output notes:** `entries[].name` is the basename, and `entries[].relativePath` is the path relative to the listed base.

### `analyze_directory`

Statistics: counts, sizes, types, largest/recent files.

| Parameter         | Default | Description         |
| ----------------- | ------- | ------------------- |
| `path`            | -       | Directory path      |
| `maxDepth`        | 10      | Analysis depth      |
| `topN`            | 10      | Top largest/recent  |
| `maxEntries`      | 20000   | Max entries scanned |
| `excludePatterns` | []      | Patterns to skip    |

### `read_media_file`

Binary files as base64 with MIME type.

| Parameter | Default | Description     |
| --------- | ------- | --------------- |
| `path`    | —       | Media file path |
| `maxSize` | 50MB    | Size limit      |

### `get_file_info`

Detailed metadata about a file or directory.

| Parameter | Default | Description               |
| --------- | ------- | ------------------------- |
| `path`    | —       | Path to file or directory |

**Returns:** name, path, type, size, created, modified, accessed, permissions, isHidden, mimeType, symlinkTarget (if applicable).

### `get_multiple_file_info`

Batch metadata retrieval for multiple files/directories (parallel processing).

| Parameter         | Default | Description                 |
| ----------------- | ------- | --------------------------- |
| `paths`           | —       | Array of paths (max 100)    |
| `includeMimeType` | true    | Include MIME type detection |

**Returns:** Array of file info with individual success/error status, plus summary (total, succeeded, failed, totalSize).

### `compute_checksums`

Compute cryptographic hashes for files using streaming (memory-efficient).

| Parameter     | Default | Description                             |
| ------------- | ------- | --------------------------------------- |
| `paths`       | —       | Array of file paths (max 50)            |
| `algorithm`   | sha256  | Hash: `md5`, `sha1`, `sha256`, `sha512` |
| `encoding`    | hex     | Output: `hex` or `base64`               |
| `maxFileSize` | 100MB   | Skip files larger than this             |

**Returns:** Array of checksums with file sizes, plus summary. Useful for integrity checks and duplicate detection.

---

## Error Codes

| Code                  | Cause                        | Solution                              |
| --------------------- | ---------------------------- | ------------------------------------- |
| `E_ACCESS_DENIED`     | Path outside allowed dirs    | Check `list_allowed_directories`      |
| `E_NOT_FOUND`         | Path doesn't exist           | Verify path with `list_directory`     |
| `E_NOT_FILE`          | Expected file, got directory | Use `list_directory` instead          |
| `E_NOT_DIRECTORY`     | Expected directory, got file | Use `read_file` instead               |
| `E_TOO_LARGE`         | File exceeds size limit      | Use `head/tail` or increase `maxSize` |
| `E_TIMEOUT`           | Operation took too long      | Reduce limits                         |
| `E_INVALID_PATTERN`   | Malformed glob/regex         | Check glob/regex syntax               |
| `E_PERMISSION_DENIED` | OS-level access denied       | Check file permissions                |

---

## Security

- **Read-only** — no writes, deletes, or modifications
- **Path validation** — symlinks cannot escape allowed directories
- **Binary detection** — prevents accidental base64 bloat
- **Input sanitization** — patterns validated for ReDoS protection
