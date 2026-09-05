# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-09-05

A minor release, not a major one: the package's own API is untouched. Its
`./transport` exports and every CLI flag and environment variable are byte-for-
byte what 2.0.0 shipped. What changed is how tool results look on the wire, and
an MCP client reading them is not an npm dependent of this package.

**If you maintain a custom MCP client, read the first entry before upgrading.**
Nothing else here needs action.

### Changed

- **Where tool metadata lives.** Tools that return a text result (`read`,
  `list`, `diff`, `patch`, `edit`, `delete`, `move`, `replace_text`,
  `search_text`, `find_files`) now ship their metadata under `_meta` instead of
  `structuredContent`. Clients that treat `structuredContent` as the canonical
  model view — Claude Code among them — discard the text blocks whenever it is
  present, so the model never saw the file `read` returned or the tree from
  `list`. It is the same object under a different field: a client doing
  `result.structuredContent.results` reads `result._meta.results` instead.
  Only `stat`, `create` and `list_roots` keep `structuredContent`.
- `read` appends a `// truncated:` line carrying the continuation args, and a
  `// sha256:` line when `includeHash` is set, after a blank line so neither can
  be read as file bytes. `list` appends a `nextCursor:` line, and a `truncated:`
  notice on hard-cap overflow.
- No tool publishes an `outputSchema` any more. Publishing one obliges the
  result to carry `structuredContent`, which every publisher has stopped doing.
- `stat`, `create` and `list_roots` no longer return a one-line text summary.
  Their value is the metadata, so they return JSON text and keep
  `structuredContent`.

### Fixed

- `list_roots` returns a `hint` naming the three ways to configure a root when
  it has none to list. An unconfigured server used to answer `{"roots":[]}` and
  leave the caller to guess; the elicitation route out — call a tool with a
  concrete path and approve the grant — appeared in no tool description.
  Present only when `roots` is empty.

## [2.0.0] - 2026-08-27

This is a breaking release. Every tool name and every environment variable
changed, and neither has a compatibility fallback. Read the two migration
tables below before upgrading.

### Breaking — tool names

The tool surface was consolidated from 17 tools to 13. Batch behaviour moved
into the single-item tools rather than living in separate `*_many` tools, and
the remaining names were made consistent.

| 1.x tool             | 2.0 equivalent                  |
| :------------------- | :------------------------------ |
| `ls`                 | `list`                          |
| `grep`               | `search_text`                   |
| `find`               | `find_files`                    |
| `mv`                 | `move`                          |
| `rm`                 | `delete`                        |
| `roots`              | `list_roots`                    |
| `apply_patch`        | `patch`                         |
| `diff_files`         | `diff`                          |
| `search_and_replace` | `replace_text`                  |
| `write`              | `create`                        |
| `tree`               | `list` with `maxDepth`          |
| `stat_many`          | `stat` with `paths[]`           |
| `calculate_hash`     | `read` with `includeHash: true` |
| `mkdir`              | removed — see below             |

`edit`, `read`, and `stat` keep their names. Both `read` and `stat` accept
either a single `path` or a `paths[]` batch.

**`mkdir` has no direct replacement.** `create` writes files and creates any
missing parent directories along the way, so a directory can be produced as a
side effect of writing a file inside it. Creating an empty directory on its own
is no longer possible through a tool call.

### Breaking — environment variables

Every environment variable is now prefixed `FS_`, with no fallback to the old
name. A configuration file carrying 1.x names will be read as entirely unset,
which for `FS_API_KEY` means an HTTP server starts unauthenticated. Audit
deployment configuration before upgrading.

| 1.19.1 variable                 | 2.0 variable             |
| :------------------------------ | :----------------------- |
| `FILESYSTEM_MCP_API_KEY`        | `FS_API_KEY`             |
| `FILESYSTEM_MCP_HTTP_HOST`      | `FS_HTTP_HOST`           |
| `FILESYSTEM_MCP_LOG_LEVEL`      | `FS_LOG_LEVEL`           |
| `FS_CONTEXT_ALLOW_SENSITIVE`    | `FS_ALLOW_SENSITIVE`     |
| `FS_CONTEXT_DENYLIST`           | `FS_DENYLIST`            |
| `FS_CONTEXT_MAX_REQUEST_BYTES`  | `FS_MAX_REQUEST_BYTES`   |
| `FS_CONTEXT_MAX_INLINE_MATCHES` | `FS_MAX_INLINE_MATCHES`  |
| `MAX_FILE_SIZE`                 | `FS_MAX_FILE_SIZE`       |
| `MAX_READ_MANY_TOTAL_SIZE`      | `FS_MAX_READ_MANY_BYTES` |
| `DEFAULT_SEARCH_TIMEOUT`        | `FS_SEARCH_TIMEOUT_MS`   |

`FS_ALLOWED_DIRS` and `NO_COLOR` keep their names.

These 1.19.1 variables are no longer read and have no replacement:
`FS_CONTEXT_ALLOWLIST`, `FS_CONTEXT_MAX_INLINE_CHARS`,
`FS_CONTEXT_STRIP_STRUCTURED`, `FS_CONTEXT_SEARCH_WORKERS`,
`FS_CONTEXT_SEARCH_WORKERS_DEBUG`, `FS_CONTEXT_LIST_CURSOR_TTL_MS`,
`FS_CONTEXT_DIAGNOSTICS`, `FS_CONTEXT_DIAGNOSTICS_DETAIL`,
`FS_CONTEXT_TOOL_LOG_ERRORS`, `MAX_SEARCH_SIZE`,
`FILESYSTEM_MCP_MAX_HTTP_SESSIONS`, `FILESYSTEM_MCP_MAX_TASK_TTL_MS`, and
`FILESYSTEM_MCP_MAX_CONCURRENT_TASKS`.

2.0 adds `FS_ROOT_BOUNDARY`, `FS_ALLOW_CWD_WALK`, `FS_ALLOW_MISSING_ROOTS`,
`FS_TRUST_PROXY`, `FS_ALLOWED_HOSTS`, `FS_ALLOWED_ORIGINS`,
`FS_ALLOW_UNRESTRICTED_HOSTS`, `FS_PUBLIC_URL`, `FS_RATE_LIMIT_RPM`,
`FS_MAX_WATCHERS`, and `FS_REQUEST_STATE_KEY`. The README documents every
variable with its default and accepted range.

Boolean parsing also changed. `true` and `1` enable a variable; `false`, `0`,
and empty disable it. Any other value now logs a warning once and reads as
disabled, where 1.x accepted it silently as false.
`FS_ALLOW_UNRESTRICTED_HOSTS` goes through the same grammar as every other
boolean rather than its own.

### Breaking — package exports

The package root export was removed. `dist/index.js` is the CLI entry point: it
parses `process.argv` and starts a server on import, and its declaration file
was empty, so importing the package root never gave callers an API. The
`filesystem-mcp` binary and the `./transport` subpath export are unaffected.

### Added

- `FS_PORT` mirrors `--port`, so the HTTP transport can be enabled entirely
  from the environment. An empty string reads as unset.
- `FS_KEEPALIVE_TIMEOUT_MS` replaces the hard-coded 5-second HTTP keep-alive.
  `headersTimeout` is derived from it as the configured value plus 5 seconds.
  Set this above the idle timeout of any proxy in front of the server.
- The published `server.json` now declares `--read-only`, the `FS_ALLOWED_DIRS`
  environment variable, and the Docker runtime arguments (`-i`, `--rm`, and the
  volume mount), so registry clients generate a working install command for
  both the npm and container packages.

### Fixed

- **`--api-key` and `--http-host` had no effect.** Both were parsed and
  documented but never reached the HTTP server, so `--api-key <secret>` started
  an unauthenticated server. `--log-level`, `--max-file-size`,
  `--root-boundary`, `--allow-sensitive`, and `--deny` were dropped the same
  way. All seven now take precedence over their environment variable, as
  `--help` has always claimed.
- **`FS_LOG_LEVEL` / `--log-level` now filters output.** The value was parsed
  and ignored; every message reached stderr regardless. Messages below the
  configured severity are now suppressed — with the default of `info`, `debug`
  output no longer appears unless requested.
- A loopback HTTP bind rejected `Host: localhost` and `Host: [::1]` with
  `403 Invalid Host`, so `http://localhost:<port>/mcp` failed on a default
  server. All three loopback spellings are accepted.
- Host allow-list values consisting only of separators or whitespace read as an
  empty allow-list that rejected every request; they now read as unset.
- A `500` on the HTTP POST route replied with `id: null` even when the request
  carried an id, leaving clients waiting for a correlatable response.
- **`delete` reported a narrower error shape than every other tool.** Its
  `failures[].error` published only `code` and `message`, dropping the `path`
  and `suggestion` the handler had already computed. It now emits
  `PerFileError`, matching `create`, `move`, and `replace`.

### Changed

- Updated core dependencies.
- Refined internal schemas and agent configurations.
- `--api-key` is documented as development-only; `FS_API_KEY` is the supported
  channel, since argv is world-readable.

### Removed

- **Removed the experimental tasks subsystem.** The task store, task-augmented
  tool execution, and the `FILESYSTEM_MCP_MAX_TASK_TTL_MS` /
  `FILESYSTEM_MCP_MAX_CONCURRENT_TASKS` settings are gone. SEP-2663 removed
  tasks from the SDK; long operations report through progress notifications
  instead.
- **Removed the `logging` capability and the `logging/setLevel` handler.**
  Clients calling `logging/setLevel` now receive `METHOD_NOT_FOUND`. The
  handler only set a field nothing read, and SEP-2577 deprecates the subsystem;
  diagnostics go to stderr, controlled by `FS_LOG_LEVEL`.
- Removed dead diagnostics, tracing, and performance tests from `observability.test.ts`.
- Removed dead W3C trace surface and unreachable diagnostics config from `observability.ts`.
- Removed dead `startPerfMeasure`/`withOpsTrace` and `withToolDiagnostics` subsystems.
- Removed dead `RESOURCE_STORE_DIAGNOSTICS_CHANNEL` and `LIFECYCLE_CHANNEL` publishers.

[2.1.0]: https://github.com/j0hanz/filesystem-mcp/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/j0hanz/filesystem-mcp/compare/v1.19.1...v2.0.0
