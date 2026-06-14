# global-roots

## 1. Goal

Enable `filesystem-mcp` to work fully when installed globally and shared across multiple
workspaces, without requiring per-project configuration or restart. Any MCP client —
whether it implements the roots protocol (VS Code, Claude Code, Cursor) or not (Claude
Desktop) — should get correctly scoped access to exactly the active workspace.

**Completion signal:** A globally-configured server instance (no positional args) serves
three independent VS Code workspaces simultaneously with each seeing only its own tree;
AND a Claude Desktop config (no roots protocol) gains access to a project directory via
elicitation, all verified by the acceptance tests in section 6.

---

## 2. Requirements

<!-- Tier 1: FS_ALLOWED_DIRS + messaging + README -->

- `REQ-001`: The server MUST parse a `FS_ALLOWED_DIRS` environment variable as a
  `:`-separated list on POSIX and `;`-separated list on Windows; each token is treated as
  an allowed root directory and merged into the baseline alongside `cliAllowedDirs`.

- `REQ-002`: The server MUST normalise each `FS_ALLOWED_DIRS` path through the same
  `normalizePath` + `resolveAllowedDirectoriesState` pipeline used for CLI positionals.
  Invalid or nonexistent entries MUST emit a startup warning via the existing log channel
  and be silently dropped (not fatal).

- `REQ-003`: When `getAllowedDirectories()` returns an empty list the server MUST emit
  an enhanced warning that names all three ways to configure roots: CLI positionals,
  `FS_ALLOWED_DIRS`, and MCP Roots protocol — plus `--allow-cwd`.

- `REQ-004`: The README global-install section MUST show a no-args pattern (relying on
  MCP roots / `${workspaceFolder}`) as the primary recipe for VS Code / Cursor / Claude
  Code, and a `FS_ALLOWED_DIRS`-based pattern as the fallback for clients without roots
  support. Per-project positional args MUST remain documented but as a secondary option.

<!-- Tier 2: FS_ROOT_BOUNDARY + cwd guards -->

- `REQ-005`: The server MUST parse a `FS_ROOT_BOUNDARY` environment variable using the
  same delimiter convention as `FS_ALLOWED_DIRS`; each entry becomes a ceiling path.
  When a baseline exists, MCP client roots MUST be filtered to only those whose real path
  falls within at least one boundary entry. Boundary entries themselves MUST NOT be
  auto-added to `allowedDirectoriesState` — only roots that land inside them are granted.

- `REQ-006a`: When `FS_ROOT_BOUNDARY` is set but no client roots are present,
  `getAllowedDirectories()` MUST return an empty list so all tools throw "No roots
  configured".
- `REQ-006b`: When `REQ-006a` applies, the empty-state warning MUST state that a
  boundary is configured but no roots have been granted yet.

- `REQ-007`: The server MUST skip the cwd root (emit a warning, do not add cwd) when
  `--allow-cwd` is set and `process.cwd()` resolves to a filesystem root (`/`, `C:\`,
  or any drive root), the user home directory (`os.homedir()`), or a path in a
  hard-coded set of known system directories (`/usr`, `/etc`, `/bin`, `/sbin`,
  `/System`, `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`).

- `REQ-008`: When `--allow-cwd` is not rejected by `REQ-007`, the effective root MUST
  be the cwd unless an opt-in env flag `FS_ALLOW_CWD_WALK=1` is set, in which case the
  server MUST walk ancestors from cwd until it finds a directory containing `.git`,
  `package.json`, or `pyproject.toml`, and use that as the effective cwd root instead.
  If no marker is found, fall back to the original cwd.

<!-- Tier 3: Elicitation-based runtime root grants -->

- `REQ-009`: A new MCP tool `request_access` MUST exist; it accepts a single `path`
  string and, when the connected client advertises `elicitation` capability, sends an
  elicitation prompt asking the user to approve or deny access to that directory.

- `REQ-010`: On user approval via elicitation, the resolved, normalised `path` MUST be
  added to the session's `PathGuard` allowed directories immediately (equivalent to
  calling `setRoots` with the merged set). The grant MUST be session-scoped only — it
  MUST NOT persist across server restarts or be written to any file.

- `REQ-011a`: On user denial, `request_access` MUST return a structured error.
- `REQ-011b`: `request_access` MUST cache each denial for the session; subsequent calls
  with the same normalised path MUST return the cached denial immediately without
  re-prompting. The cache MUST be cleared when the server disposes session state.

<!-- Security -->

- `SEC-001`: `FS_ALLOWED_DIRS` entries MUST go through symlink resolution (`realpath`);
  the resolved real path MUST also satisfy the allowed-directory containment check.
- `SEC-001b`: `FS_ROOT_BOUNDARY` entries MUST go through the same symlink resolution;
  client roots whose real paths fall outside the resolved boundary MUST be filtered out.

- `SEC-002`: If `FS_ROOT_BOUNDARY` is set, an elicitation-granted path (`REQ-010`) MUST
  also fall within at least one boundary entry; if not, the grant MUST be rejected even
  after user approval, with a clear error message.

- `SEC-003`: `request_access` MUST NOT be callable on clients that do not advertise
  `elicitation` capability; it MUST return `ErrorCode.ACCESS_DENIED` with a message
  explaining that the client does not support runtime access grants.

- `SEC-004`: The cwd walk (`REQ-008`) MUST NOT traverse outside `FS_ROOT_BOUNDARY` (if
  set) or outside the user home directory; it MUST stop and fall back to original cwd if
  no valid marker is found within those limits.

<!-- Performance -->

- `PERF-001`: `FS_ALLOWED_DIRS` and `FS_ROOT_BOUNDARY` parsing MUST add no more than
  50 ms to startup time as measured by the existing `dist-runtime.test.ts` suite
  (parallel `stat` calls, same pattern as CLI validation).

---

## 3. Constraints

- `CON-001`: All existing behaviour MUST be preserved — servers launched with positional
  args, `--allow-cwd`, or pure MCP roots (no env vars) MUST behave identically to the
  current implementation. No breaking changes to the public CLI interface.

- `CON-002`: New env vars MUST follow the existing project naming convention:
  `FS_ALLOWED_DIRS` and `FS_ROOT_BOUNDARY` (matching the `FS_CONTEXT_*` family for
  filesystem policy settings, `FILESYSTEM_MCP_*` reserved for HTTP transport settings).

- `CON-003`: Elicitation (`REQ-009`–`REQ-011`) MUST gracefully degrade: if the client
  does not support `elicitation`, the tool returns `ACCESS_DENIED` — it MUST NOT throw
  or crash the server.

- `CON-004`: The `FS_ROOT_BOUNDARY` concept MUST NOT appear in `PathGuard.getAllowedDirectories()`
  output — boundaries are an internal filter, not visible roots. The `list_roots` tool
  SHOULD reflect only actually-granted paths.

- `CON-005`: Tier-2 and Tier-3 features MUST be independently deployable — a build with
  only Tier-1 changes MUST pass all tests; Tier-2 can be merged before Tier-3.

---

## 4. Interfaces

<!-- 4a: FS_ALLOWED_DIRS env var -->

**Input:**

- `FS_ALLOWED_DIRS` (string, optional): `:`-separated (POSIX) or `;`-separated (Windows)
  list of absolute directory paths, e.g. `~/projects:/tmp/scratch`.

**Output:** Merged into `PathGuard` baseline; reflected in `list_roots` output.

**Errors:**

- Nonexistent or non-directory path: warning logged, entry dropped (non-fatal).
- Path normalisation failure: warning logged, entry dropped (non-fatal).

<!-- 4b: FS_ROOT_BOUNDARY env var -->

**Input:**

- `FS_ROOT_BOUNDARY` (string, optional): same delimiter convention as `FS_ALLOWED_DIRS`.
  E.g. `FS_ROOT_BOUNDARY=~` limits all client roots to within home dir.

**Output:** Used as filter ceiling in `filterRootsWithinBaseline`. Not reflected in
`list_roots` output.

**Errors:**

- Nonexistent boundary path: warning, boundary entry dropped.
- Client root outside boundary: silently filtered out (existing behaviour).

<!-- 4c: --allow-cwd safety guard -->

**Input:** `--allow-cwd` CLI flag + `process.cwd()` at startup.

**Output:** cwd added to baseline ONLY when cwd is not a filesystem root, home dir, or
known system path. With `FS_ALLOW_CWD_WALK=1`, effective root is ancestor with marker.

**Errors:**

- Unsafe cwd: warning emitted, cwd silently skipped. Server continues without cwd root.

<!-- 4d: request_access tool (Tier 3) -->

**Input:**

- `path` (string, required): Absolute or `~`-prefixed path to request access to.

**Output (success):**

```json
{ "ok": true, "granted": "/absolute/resolved/path" }
```

**Output (denied):**

```json
{ "ok": false, "reason": "User denied access to /absolute/resolved/path" }
```

**Errors:**

- `ACCESS_DENIED` (client does not support elicitation)
- `ACCESS_DENIED` (path outside `FS_ROOT_BOUNDARY` even if user approved)
- `INVALID_INPUT` (path is not a valid absolute directory)
- `ACCESS_DENIED` (session-cached denial)

---

## 5. Context

- **Files:**
  - [`src/core/path.ts`](../src/core/path.ts) — `PathGuard`, `recomputeAllowedDirectories`, `filterRootsWithinBaseline`
  - [`src/cli.ts`](../src/cli.ts) — CLI arg parsing, `--allow-cwd` logic
  - [`src/core/registrar.ts`](../src/core/registrar.ts) — `McpRootsSynchronizer`, empty-state warning
  - [`src/tools/roots.ts`](../src/tools/roots.ts) — `list_roots` tool
  - [`src/tools/index.ts`](../src/tools/index.ts) — tool registration
  - [`src/core/primitives.ts`](../src/core/primitives.ts) — `parseTrueEnvFlag` helper
  - [`README.md`](../README.md) — docs

- **Current behaviour:**
  - Baseline = `cliAllowedDirs` + optional cwd. No env-var source exists.
  - `filterRootsWithinBaseline` is called when baseline is non-empty; otherwise client
    roots are adopted as-is with no ceiling.
  - `--allow-cwd` always adds cwd regardless of what that path is.
  - Empty-state warning names only CLI args and `--allow-cwd`.

- **Conventions:**
  - `defineTool()` with dual Zod schemas; `z from 'zod/v4'`; RE2 for user patterns.
  - `Problem.*()` / `FsError` factories — never `new Error()` in tool code.
  - All fs ops through `ctx.fs` (`GuardedFileSystem`), never `node:fs` directly.
  - `parseTrueEnvFlag` for boolean env vars; new string-list parsing should live in
    `src/core/primitives.ts` following the same pattern as `buildSensitivePatterns`.
  - ESM `.js` extensions on local imports.
  - Tests: Node built-in runner (`node --test`), unit in `__tests__/unit/`, integration
    in `__tests__/tools/`.

---

## 6. Acceptance Criteria & Validation

- `AC-001`: A server started with `FS_ALLOWED_DIRS=/tmp/a:/tmp/b` (no CLI args) allows
  reads inside `/tmp/a` and `/tmp/b` and denies reads outside both.
- `VAL-001`: `node --test --import tsx "__tests__/unit/env-allowed-dirs.test.ts"`

- `AC-002`: A server started with no args and `FS_ALLOWED_DIRS` unset emits a warning
  that mentions CLI positionals, `FS_ALLOWED_DIRS`, and MCP Roots protocol.
- `VAL-002`: `node --test --import tsx "__tests__/unit/empty-state-warning.test.ts"`

- `AC-003`: `FS_ROOT_BOUNDARY=~/projects` with a client root of `/home/user/projects/app`
  → root granted. Same server with client root `/home/user/secret` → root silently
  filtered, `list_roots` returns empty.
- `VAL-003`: `node --test --import tsx "__tests__/unit/root-boundary.test.ts"`

- `AC-004`: `--allow-cwd` with cwd = `/` or `$HOME` does NOT add cwd to allowed dirs;
  a warning is logged; `list_roots` returns empty.
- `VAL-004`: `node --test --import tsx "__tests__/unit/allow-cwd-guard.test.ts"`

- `AC-005`: `--allow-cwd` with `FS_ALLOW_CWD_WALK=1` and cwd = `/home/user/projects/app/src`
  where `/home/user/projects/app` contains `.git` → effective root is `.../app`, not `.../src`.
- `VAL-005`: `node --test --import tsx "__tests__/unit/cwd-walk.test.ts"`

- `AC-006`: `request_access` on an elicitation-capable client with user approval → path
  added to allowed dirs, subsequent `read` on a file inside succeeds.
- `VAL-006`: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`

- `AC-007`: `request_access` on a client without elicitation capability → returns
  `ACCESS_DENIED` without crashing.
- `VAL-007`: `node --test --import tsx "__tests__/tools/elicitation.test.ts"`

- `AC-008`: Existing tests continue to pass unchanged.
- `VAL-008`: `node scripts/tasks.mjs`

---

## 7. Examples & Edge Cases

**Positive — global VS Code install (roots protocol):**

```
Config: no CLI args, no env vars
Client sends: notifications/roots/list_changed → roots = [file:///home/user/projects/myapp]
Result:       list_roots → ["/home/user/projects/myapp"]
```

**Positive — global Claude Desktop install (no roots protocol):**

```
Config: FS_ALLOWED_DIRS=~/projects
Client sends: (nothing — no roots protocol)
Result:       list_roots → ["/home/user/projects"]
```

**Positive — boundary + workspace root:**

```
Config: FS_ROOT_BOUNDARY=~/projects  (no CLI args)
Client sends root: ~/projects/myapp  → GRANTED (inside boundary)
Client sends root: ~/secrets         → FILTERED (outside boundary)
Result: list_roots → ["/home/user/projects/myapp"]
```

**Edge — FS_ALLOWED_DIRS with nonexistent path:**

```
FS_ALLOWED_DIRS=/exists:/does-not-exist
Result: /exists added; /does-not-exist dropped with warning; server starts normally.
```

**Edge — --allow-cwd with home dir as cwd:**

```
cwd = /home/user, --allow-cwd set
Result: cwd NOT added; warning emitted; list_roots → [] or whatever other roots give.
```

**Edge — elicitation denial cached:**

```
request_access("/tmp/sensitive") → user denies
request_access("/tmp/sensitive") → cached denial, no elicitation prompt sent
```

**Edge — FS_ROOT_BOUNDARY blocks elicitation approval:**

```text
FS_ROOT_BOUNDARY=~/projects
request_access("/etc/passwd") approved by user
Result: ACCESS_DENIED — path outside boundary.
```
