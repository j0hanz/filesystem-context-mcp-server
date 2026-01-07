# Filesystem Context MCP Server

> Read-only tools for exploring directories, searching files, and reading
> content via the Model Context Protocol (MCP).

This server lets assistants inspect files safely. All operations are limited to
explicitly allowed directories and never write to disk.

---

## Quick Reference

| Goal                | Tool                       | Key Parameters                      |
| ------------------- | -------------------------- | ----------------------------------- |
| Check access        | `list_allowed_directories` | -                                   |
| List contents       | `list_directory`           | `recursive`, `excludePatterns`      |
| Find files          | `search_files`             | `pattern` (glob), `maxResults`      |
| Search in files     | `search_content`           | `pattern` (regex), `contextLines`   |
| Read file           | `read_file`                | `head`, `tail`, `lineStart/lineEnd` |
| Read multiple files | `read_multiple_files`      | `paths[]` - preferred for 2+        |
| File metadata       | `get_file_info`            | `path`                              |
| Batch file metadata | `get_multiple_file_info`   | `paths[]` - preferred for 2+        |

---

## Core Concepts

- **Allowed directories:** All tools only operate inside the allowed roots.
  Run `list_allowed_directories` first to confirm scope.
- **Globs vs regex:** `search_files` uses glob patterns, `search_content` uses
  regex (set `isLiteral=true` to search for exact text).
- **Symlinks:** Symlinks are never followed for security.

---

## Workflows

### Project discovery

```text
list_allowed_directories
list_directory(path=".", recursive=true, maxDepth=3)
read_multiple_files(["package.json", "README.md"])
```

### Find and read code

```text
search_files(pattern="**/*.ts")
read_multiple_files([...results])
```

### Search patterns in code

```text
search_content(pattern="TODO|FIXME", filePattern="**/*.ts", contextLines=2)
```

---

## Common Glob Patterns

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

- Use `read_multiple_files` for 2+ files (parallel, resilient).
- Set `maxResults` limits on searches for large codebases.
- Use `excludePatterns=["node_modules/**", ".git/**", "dist/**"]`.
- Preview large files with `head=50` before full reads.

**Don't:**

- Loop `read_file` for multiple files.
- Search without `maxResults` on large codebases.

---

## Tool Details

### `list_allowed_directories`

List all directories this server can access.

| Parameter | Default | Description |
| --------- | ------- | ----------- |
| (none)    | -       | -           |

---

### `list_directory`

List contents of a directory with optional recursion. Returns entry name,
relative path, type, size, and modified date. Symlinks are not followed.

| Parameter         | Default | Description            |
| ----------------- | ------- | ---------------------- |
| `path`            | -       | Directory path         |
| `recursive`       | false   | Include subdirectories |
| `excludePatterns` | []      | Glob patterns to skip  |

For filtered file searches (e.g., "find all \*.ts files"), use `search_files` instead.

---

### `search_files`

Find files (not directories) using glob patterns.

| Parameter         | Default  | Description                           |
| ----------------- | -------- | ------------------------------------- |
| `path`            | -        | Base directory                        |
| `pattern`         | -        | Glob: `**/*.ts`, `src/**`             |
| `excludePatterns` | built-in | Patterns to skip (pass [] to disable) |
| `maxResults`      | 100      | Limit (up to 10,000)                  |

---

### `search_content`

Grep-like search across file contents using regex. Returns matching lines
with 2 lines of context before and after each match.

| Parameter         | Default  | Description                                |
| ----------------- | -------- | ------------------------------------------ |
| `path`            | -        | Base directory                             |
| `pattern`         | -        | Regex: `TODO\|FIXME`                       |
| `filePattern`     | `**/*`   | Glob filter for files                      |
| `excludePatterns` | built-in | Glob patterns to skip (pass [] to disable) |
| `caseSensitive`   | false    | Case-sensitive matching                    |
| `isLiteral`       | false    | Treat pattern as literal string            |
| `maxResults`      | 100      | Maximum matches to return                  |

Note: `excludePatterns` uses a built-in list of common dependency/build
folders (e.g., `node_modules`, `dist`, `build`, `coverage`, `.git`, `.vscode`).
Pass `excludePatterns: []` to disable it.

---

### `read_file`

Read a single text file with optional line selection.

| Parameter   | Default | Description            |
| ----------- | ------- | ---------------------- |
| `path`      | -       | File path              |
| `head`      | -       | First N lines          |
| `tail`      | -       | Last N lines           |
| `lineStart` | -       | Start line (1-indexed) |
| `lineEnd`   | -       | End line (inclusive)   |

Note: `head`/`tail` cannot be combined with `lineStart`/`lineEnd`.

---

### `read_multiple_files`

Read multiple files in parallel. Each file reports success or error.

| Parameter   | Default | Description                     |
| ----------- | ------- | ------------------------------- |
| `paths`     | -       | Array (max 100)                 |
| `head`      | -       | First N lines each              |
| `tail`      | -       | Last N lines each               |
| `lineStart` | -       | Start line (1-indexed) per file |
| `lineEnd`   | -       | End line (inclusive) per file   |

Note: `head`/`tail` cannot be combined with `lineStart`/`lineEnd`.

---

### `get_file_info`

Get metadata about a file or directory without reading contents.

| Parameter | Default | Description               |
| --------- | ------- | ------------------------- |
| `path`    | -       | Path to file or directory |

Returns: name, path, type, size, created, modified, accessed, permissions,
isHidden, mimeType, symlinkTarget (if applicable).

---

### `get_multiple_file_info`

Get metadata for multiple files/directories in parallel.

| Parameter | Default | Description              |
| --------- | ------- | ------------------------ |
| `paths`   | -       | Array of paths (max 100) |

Returns: Array of file info with individual success/error status, plus
summary (total, succeeded, failed, totalSize).

---

## Error Codes

| Code                  | Cause                        | Solution                          |
| --------------------- | ---------------------------- | --------------------------------- |
| `E_ACCESS_DENIED`     | Path outside allowed dirs    | Check `list_allowed_directories`  |
| `E_NOT_FOUND`         | Path does not exist          | Verify path with `list_directory` |
| `E_NOT_FILE`          | Expected file, got directory | Use `list_directory` instead      |
| `E_NOT_DIRECTORY`     | Expected directory, got file | Use `read_file` instead           |
| `E_TOO_LARGE`         | File exceeds size limit      | Use `head/tail` for partial reads |
| `E_TIMEOUT`           | Operation took too long      | Reduce scope or use `maxResults`  |
| `E_INVALID_PATTERN`   | Malformed glob/regex         | Check pattern syntax              |
| `E_PERMISSION_DENIED` | OS-level access denied       | Check file permissions            |

---

## Security

- Read-only: no writes, deletes, or modifications.
- Path validation: symlinks cannot escape allowed directories.
- Binary detection: prevents accidental binary reads.
- Input sanitization: patterns validated for ReDoS protection.
