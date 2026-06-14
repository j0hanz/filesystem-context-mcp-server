# mcp-config-helper

## 1. Goal

- One sentence: Add a suite of CLI subcommands (`allow`, `disallow`, `list-allowed`) to `filesystem-mcp` to seamlessly manage directory authorization in MCP client configurations.
- Completion signal: The CLI subcommand suite successfully discovers, parses, validates, and modifies configuration files for Claude Desktop, Cursor, Cline, Roo Code, and global MCP settings without disrupting other configuration properties.

## 2. Requirements

- `REQ-001`: Subcommand `allow [path]` MUST resolve the target path (defaulting to `.`) to an absolute path, validate its safety, and append it to the `args` array of the target server in all detected client configurations.
- `REQ-002`: Subcommand `disallow [path]` MUST resolve the target path and remove it from the target server's `args` array in all detected configurations.
- `REQ-003`: Subcommand `list-allowed` MUST list all configured allowed directories for the target server across all detected configurations.
- `REQ-004`: The helper MUST automatically discover configurations for Claude Desktop, Cursor Global, Cline (VS Code), Roo Code (VS Code), and general global MCP config.
- `REQ-005`: The CLI MUST support `--client <name>` (to filter targeting specific clients) and `--config <path>` (to target a specific config file).
- `REQ-006`: The configuration updater MUST write modified JSON files atomically using a temp file write followed by a rename, preserving 2-space indentation.
- `REQ-201`: The tool MUST support `--json` for machine-readable output.
- `REQ-202`: The tool MUST exit with a non-zero code on failure.
- `COMP-201`: The tool MUST be compatible with POSIX-compliant shells and Windows PowerShell.
- `SEC-001`: The tool MUST validate path safety (null bytes, drive-relative, reserved devices) before updating any configuration.
- `SEC-002`: The tool MUST warn the user if a target configuration uses Docker instead of direct execution.

## 3. Constraints

- `CON-001`: The tool MUST NOT attempt to edit SQLite databases (such as Cursor's internal UI storage).
- `CON-002`: The tool MUST NOT overwrite or write back to files that fail JSON parsing (to prevent corrupting user configs).

## 4. Interfaces

The system exposes the following interfaces:

### Command Line Interface

**Input Arguments/Flags:**

- `positionals` (subcommand + optional path): Subcommand `allow`, `disallow`, or `list-allowed`. Path defaults to `.` for `allow`/`disallow`.
- `--client` (string, optional): One of `claude`, `cursor`, `cline`, `roocode`, `global` to restrict file modification.
- `--config` (string, optional): Specific file path to target.
- `--server-name` (string, optional): Key of the server under `mcpServers` (defaults to `filesystem` or `filesystem-mcp`).
- `--dry-run` (boolean, optional): Dry run flag to print proposed changes without writing.
- `--json` (boolean, optional): Format list or status outputs as JSON.

**Output:**

- Status/Success messages on stdout.
- Error messages on stderr.
- Exit codes: `0` for success, `1` for failures.

## 5. Context

- Files:
  - [src/cli.ts](file:///C:/filesystem-mcp/src/cli.ts) (Existing file to be updated with subcommands, discovery, and file modification logic)
  - [src/index.ts](file:///C:/filesystem-mcp/src/index.ts) (CLI execution routing)
- Current behavior: No configuration modification capability exists in the CLI; users must manually edit configuration files.
- Conventions: Use standard ESM imports with `.js` suffix, Node built-ins, standard errors using `CliExitError`.

## 6. Acceptance Criteria & Validation

- `AC-001`: Invoking `allow` adds the absolute resolved path to the config file `args`.
- `VAL-001`: `node dist/index.js allow C:\test-dir --config temp_config.json && grep "C:\\\\test-dir" temp_config.json`
- `AC-002`: Invoking `disallow` removes the path.
- `VAL-002`: `node dist/index.js disallow C:\test-dir --config temp_config.json && ! grep "C:\\\\test-dir" temp_config.json`
- `AC-003`: Invoking `list-allowed` displays the configured paths.
- `VAL-003`: `node dist/index.js list-allowed --config temp_config.json`

## 7. Examples & Edge Cases

**Positive example:**

```
Input:  allow C:\projects\my-app --config temp.json
Output: Success! Authorized C:\projects\my-app in temp.json
```

**Edge cases:**

- Config file does not exist: create it with `{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@j0hanz/filesystem-mcp", "C:\\projects\\my-app"] } } }`.
- JSON is invalid: Exit with status code 1, print descriptive message to stderr, and do not write to the file.
- Path is already allowed: Report that it is already allowed without duplicate entry.
