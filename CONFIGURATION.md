# Configuration Guide

Environment variables for tuning performance and resource limits. All variables are optional. Defaults work for most use cases.

## Directory Access

- Pass directory paths as CLI arguments to define allowed roots.
- Use `--allow-cwd` to add the current working directory as an allowed root.
- If the MCP client supports Roots, its roots are used when no CLI paths are provided.
- If CLI paths and/or `--allow-cwd` are provided, client roots are only accepted if they are within those baseline directories.
- If nothing is configured and the client provides no roots, the server has no access and logs a warning.

## Environment Variables

Values are integers. Sizes are in bytes, timeouts are in milliseconds.

### Performance and Concurrency

| Variable                         | Default                 | Range   | Description                                                       | Increase For         | Decrease For           |
| -------------------------------- | ----------------------- | ------- | ----------------------------------------------------------------- | -------------------- | ---------------------- |
| `UV_THREADPOOL_SIZE`             | (unset)                 | 1-1024  | libuv threadpool size (set before start). Caps parallelism.       | Heavy fs/crypto load | Memory-constrained     |
| `FILESYSTEM_CONTEXT_CONCURRENCY` | Auto (2x cores, cap 50) | 1-100   | Parallel file operations (further capped by `UV_THREADPOOL_SIZE`) | SSDs, many CPU cores | HDDs, shared systems   |
| `TRAVERSAL_JOBS`                 | 8                       | 1-50    | Directory traversal parallelism                                   | Fast storage         | Network drives         |
| `REGEX_TIMEOUT`                  | 100                     | 50-1000 | Regex timeout per line (prevents ReDoS)                           | Complex patterns     | CI/CD, simple searches |

> Note: `UV_THREADPOOL_SIZE` must be set before the process starts.

### File Size Limits

| Variable          | Default | Range      | Applies To                         | Increase For       | Decrease For      |
| ----------------- | ------- | ---------- | ---------------------------------- | ------------------ | ----------------- |
| `MAX_FILE_SIZE`   | 10MB    | 1MB-100MB  | `read_file`, `read_multiple_files` | Large logs/data    | Low memory        |
| `MAX_SEARCH_SIZE` | 1MB     | 100KB-10MB | `search_content`                   | Large source files | Performance focus |

### Default Operation Limits

| Variable                   | Default | Range       | Applies To                       |
| -------------------------- | ------- | ----------- | -------------------------------- |
| `DEFAULT_DEPTH`            | `10`    | 1-100       | `list_directory`, `search_files` |
| `DEFAULT_RESULTS`          | `100`   | 10-10000    | `search_files`, `search_content` |
| `DEFAULT_LIST_MAX_ENTRIES` | `10000` | 100-100000  | `list_directory`                 |
| `DEFAULT_SEARCH_MAX_FILES` | `20000` | 100-100000  | `search_files`, `search_content` |
| `DEFAULT_SEARCH_TIMEOUT`   | `30000` | 100-3600000 | `search_files`, `search_content` |

## Configuration Examples

### Basic Configuration (VS Code)

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

### With Environment Variables

```json
{
  "servers": {
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "${workspaceFolder}"
      ],
      "env": {
        "FILESYSTEM_CONTEXT_CONCURRENCY": "30",
        "TRAVERSAL_JOBS": "12",
        "REGEX_TIMEOUT": "150",
        "MAX_FILE_SIZE": "20971520"
      }
    }
  }
}
```

### Multiple Directories

```json
{
  "servers": {
    "filesystem-context": {
      "command": "npx",
      "args": [
        "-y",
        "@j0hanz/filesystem-context-mcp@latest",
        "${workspaceFolder}",
        "C:\\additional\\path"
      ]
    }
  }
}
```

## Use Case Profiles

**High-Performance Workstation**

```json
{
  "env": {
    "FILESYSTEM_CONTEXT_CONCURRENCY": "40",
    "TRAVERSAL_JOBS": "16",
    "REGEX_TIMEOUT": "200",
    "MAX_FILE_SIZE": "20971520"
  }
}
```

_Use for: Fast SSD, many CPU cores, complex regex searches_

**CI/CD Pipeline**

```json
{
  "env": {
    "FILESYSTEM_CONTEXT_CONCURRENCY": "10",
    "REGEX_TIMEOUT": "50",
    "MAX_SEARCH_SIZE": "524288"
  }
}
```

_Use for: Fast execution, minimal resources, literal searches_

**Resource-Constrained**

```json
{
  "env": {
    "FILESYSTEM_CONTEXT_CONCURRENCY": "5",
    "TRAVERSAL_JOBS": "3",
    "MAX_FILE_SIZE": "5242880"
  }
}
```

_Use for: Containers, shared servers, slow disks_

## Troubleshooting

| Issue                            | Solution                                     |
| -------------------------------- | -------------------------------------------- |
| Regex timeout warnings           | Increase `REGEX_TIMEOUT` or simplify pattern |
| Environment variable not applied | Restart client, verify JSON syntax           |
| Invalid value warning            | Check range limits in tables above           |

## Command Line Arguments

```bash
# Single directory
filesystem-context-mcp /path/to/project

# Multiple directories
filesystem-context-mcp /path/to/dir1 /path/to/dir2

# Allow current working directory (optional)
filesystem-context-mcp --allow-cwd

# Allow current directory plus explicit roots
filesystem-context-mcp --allow-cwd /path/to/project
```

---

Notes:

- All `env` values must be strings: `"150"` not `150`.
- `${workspaceFolder}` auto-expands in VS Code.
- Only configure variables that differ from defaults.
