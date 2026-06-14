# mcp-config-helper

Spec: [mcp-config-helper.specs.md](mcp-config-helper.specs.md)

## Goal

Add a suite of CLI subcommands (`allow`, `disallow`, `list-allowed`) to `filesystem-mcp` to seamlessly manage directory authorization in MCP client configurations. The CLI subcommand suite successfully discovers, parses, validates, and modifies configuration files for Claude Desktop, Cursor, Cline, Roo Code, and global MCP settings without disrupting other configuration properties.

## PHASE-001: Implementation

### TASK-001: Implement COMP-201

Depends on: none
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: none
Satisfies: COMP-201
Action: Ensure cross-platform shell compatibility by using Node.js built-ins (`os`, `path`) and standard ESM coding conventions within `src/cli.ts`.
Validate: `npm run build`
Expected result: TypeScript builds successfully without compilation errors.

### TASK-002: Implement REQ-001

Depends on: TASK-001
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [allowPath](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: REQ-001
Action: Implement `allowPath` in `cli.ts` to append a resolved absolute path to the target server's arguments in the config file.
Validate: `npx tsx -e "import { allowPath } from './src/cli.js'; console.log(typeof allowPath === 'function')"`
Expected result: Prints `true` to console.

### TASK-003: Implement REQ-002

Depends on: TASK-002
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [disallowPath](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: REQ-002
Action: Implement `disallowPath` in `cli.ts` to remove a normalized absolute path from the target server's arguments list.
Validate: `npx tsx -e "import { disallowPath } from './src/cli.js'; console.log(typeof disallowPath === 'function')"`
Expected result: Prints `true` to console.

### TASK-004: Implement REQ-003

Depends on: TASK-003
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [listAllowedPaths](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: REQ-003
Action: Implement `listAllowedPaths` in `cli.ts` to extract and list allowed directories from all detected client configurations.
Validate: `npx tsx -e "import { listAllowedPaths } from './src/cli.js'; console.log(typeof listAllowedPaths === 'function')"`
Expected result: Prints `true` to console.

### TASK-005: Implement REQ-004

Depends on: TASK-004
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [getExistingConfigPaths](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: REQ-004
Action: Implement a detection algorithm to locate client configuration paths for Claude Desktop, Cursor, Cline, Roo Code, and global settings on Windows, macOS, and Linux.
Validate: `npx tsx -e "import { getExistingConfigPaths } from './src/cli.js'; console.log(Array.isArray(getExistingConfigPaths()))"`
Expected result: Prints `true` to console.

### TASK-006: Implement REQ-005

Depends on: TASK-005
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [parseArgs](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: REQ-005
Action: Integrate the subcommand suite and options (`--client`, `--config`, `--server-name`, `--dry-run`) into `src/cli.ts` command parsing.
Validate: `npx tsx -e "import { parseArgs } from './src/cli.js'; console.log(typeof parseArgs === 'function')"`
Expected result: Prints `true` to console.

### TASK-007: Implement REQ-006

Depends on: TASK-006
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [writeJsonAtomic](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: REQ-006
Action: Implement atomic JSON file writing using a temp file and rename pattern, maintaining 2-space indentation formatting.
Validate: `npx tsx -e "import { writeJsonAtomic } from './src/cli.js'; console.log(typeof writeJsonAtomic === 'function')"`
Expected result: Prints `true` to console.

### TASK-008: Implement REQ-201

Depends on: TASK-007
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts), [index.ts](file:///C:/filesystem-mcp/src/index.ts)
Symbols: [main](file:///C:/filesystem-mcp/src/index.ts)
Satisfies: REQ-201
Action: Support formatting the output of the CLI subcommands as a JSON string when the `--json` option is specified.
Validate: `npm run build && node dist/index.js list-allowed --json --config package.json`
Expected result: Prints a JSON block to stdout (representing configured paths or an empty list/object).

### TASK-009: Implement REQ-202

Depends on: TASK-008
Files: [index.ts](file:///C:/filesystem-mcp/src/index.ts)
Symbols: [main](file:///C:/filesystem-mcp/src/index.ts)
Satisfies: REQ-202
Action: Route subcommand failures through `CliExitError` ensuring a non-zero exit code is returned to the process caller.
Validate: `node dist/index.js allow invalid_null_byte_value\u0000; node -e "if (process.exitCode !== 1) throw new Error('Incorrect exit code')" || echo "fails"`
Expected result: Node process catches the incorrect exit code or exits with 1.

### TASK-010: Implement SEC-001

Depends on: TASK-009
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [allowPath](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: SEC-001
Action: Wrap path inputs with the existing `validateCliPath()` checks to block unsafe inputs like null-bytes or reserved device names.
Validate: `npx tsx -e "import { validateCliPath } from './src/cli.js'; validateCliPath('con')" || echo "throws"`
Expected result: Prints "throws" when checking Windows reserved names.

### TASK-011: Implement SEC-002

Depends on: TASK-010
Files: [cli.ts](file:///C:/filesystem-mcp/src/cli.ts)
Symbols: [checkDockerWarning](file:///C:/filesystem-mcp/src/cli.ts)
Satisfies: SEC-002
Action: Add a check that detects if the server's matched configuration runs via `docker`, and outputs a warning message to stderr.
Validate: `npm run build && node dist/index.js allow C:\test-dir --config package.json`
Expected result: Executes successfully but logs any Docker warnings.

## PHASE-END: Acceptance

### TASK-012: Final acceptance verification

Depends on: TASK-011
Files: [config-helper.test.ts](file:///C:/filesystem-mcp/__tests__/unit/config-helper.test.ts)
Symbols: none
Satisfies: AC-001, AC-002, AC-003
Action: Write and run a full unit test suite `__tests__/unit/config-helper.test.ts` covering path resolution, JSON formatting, discovery heuristics, and CLI routing.
Validate: `npm run build && node --test --import tsx "__tests__/unit/config-helper.test.ts"`
Expected result: All unit tests pass.
