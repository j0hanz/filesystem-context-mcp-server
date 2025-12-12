# Filesystem Context MCP Server

> **Read-only** tools for exploring directories, searching files, and analyzing codebases.

## Quick Reference

| Goal                | Tool                       | Key Parameters                      |
| ------------------- | -------------------------- | ----------------------------------- |
| Check access        | `list_allowed_directories` | —                                   |
| Project structure   | `directory_tree`           | `maxDepth`, `excludePatterns`       |
| List contents       | `list_directory`           | `recursive`, `sortBy`               |
| Directory stats     | `analyze_directory`        | `topN`, `excludePatterns`           |
| Find files          | `search_files`             | `pattern` (glob), `maxResults`      |
| Search in files     | `search_content`           | `pattern` (regex), `contextLines`   |
| Read file           | `read_file`                | `head`, `tail`, `lineStart/lineEnd` |
| Read multiple files | `read_multiple_files`      | `paths[]` — **preferred for 2+**    |
| File metadata       | `get_file_info`            | —                                   |
| Binary/media files  | `read_media_file`          | `maxSize`                           |

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

Find files by glob pattern.

| Parameter         | Default | Description               |
| ----------------- | ------- | ------------------------- |
| `path`            | —       | Base directory            |
| `pattern`         | —       | Glob: `**/*.ts`, `src/**` |
| `excludePatterns` | []      | Patterns to skip          |
| `maxResults`      | —       | Limit (up to 10,000)      |
| `sortBy`          | "path"  | `name/size/modified/path` |

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

### `read_file`

Read single file with line selection.

| Parameter   | Default | Description                     |
| ----------- | ------- | ------------------------------- |
| `path`      | —       | File path                       |
| `encoding`  | utf-8   | `utf-8/ascii/base64/hex/latin1` |
| `maxSize`   | 10MB    | Size limit                      |
| `head`      | —       | First N lines                   |
| `tail`      | —       | Last N lines                    |
| `lineStart` | —       | Start line (1-indexed)          |
| `lineEnd`   | —       | End line (inclusive)            |

> ⚠️ Cannot combine `head/tail` with `lineStart/lineEnd`

### `read_multiple_files`

Parallel batch reads — failures don't block others.

| Parameter  | Default | Description        |
| ---------- | ------- | ------------------ |
| `paths`    | —       | Array (max 100)    |
| `encoding` | utf-8   | Encoding for all   |
| `maxSize`  | 10MB    | Per-file limit     |
| `head`     | —       | First N lines each |
| `tail`     | —       | Last N lines each  |

### `list_directory`

Flat listing with metadata.

| Parameter    | Default | Description               |
| ------------ | ------- | ------------------------- |
| `path`       | —       | Directory path            |
| `recursive`  | false   | Include subdirs           |
| `sortBy`     | "name"  | `name/size/modified/type` |
| `maxDepth`   | 10      | Depth when recursive      |
| `maxEntries` | —       | Limit (up to 100,000)     |

### `analyze_directory`

Statistics: counts, sizes, types, largest/recent files.

| Parameter         | Default | Description        |
| ----------------- | ------- | ------------------ |
| `path`            | —       | Directory path     |
| `maxDepth`        | 10      | Analysis depth     |
| `topN`            | 10      | Top largest/recent |
| `excludePatterns` | []      | Patterns to skip   |

### `read_media_file`

Binary files as base64 with MIME type and dimensions.

| Parameter | Default | Description     |
| --------- | ------- | --------------- |
| `path`    | —       | Media file path |
| `maxSize` | 50MB    | Size limit      |

## Error Codes

| Code                | Solution                              |
| ------------------- | ------------------------------------- |
| `E_ACCESS_DENIED`   | Check `list_allowed_directories`      |
| `E_NOT_FOUND`       | Verify path with `list_directory`     |
| `E_NOT_FILE`        | Use `list_directory` instead          |
| `E_TOO_LARGE`       | Use `head/tail` or increase `maxSize` |
| `E_BINARY_FILE`     | Use `read_media_file`                 |
| `E_TIMEOUT`         | Reduce limits                         |
| `E_INVALID_PATTERN` | Check glob/regex syntax               |

## Security

- **Read-only** — no writes, deletes, or modifications
- **Path validation** — symlinks cannot escape allowed directories
- **Binary detection** — prevents accidental base64 bloat
