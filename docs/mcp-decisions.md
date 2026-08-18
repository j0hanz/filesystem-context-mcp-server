# MCP architecture decisions

Decisions that are deliberate and would otherwise read as omissions. Each one
names the constraint it accepts and what would change it.

## SDK and protocol

**Split v2 packages, pinned exact.** `@modelcontextprotocol/server`,
`/client`, `/node`, and `/express` at `2.0.0`. No v1 (`@modelcontextprotocol/sdk`)
imports remain. The client package is a devDependency: it exists for the test
harness only, there is no production client role.

**Interaction surfaces target the 2025-11-25 era only.** `listRoots()` and
`ctx.mcpReq.elicitInput()` are used directly; there is no `inputRequired()` /
`ctx.mcpReq.inputResponses` fallback for the 2026-07-28 era, where the
push-style server-to-client request model is gone and both throw. Both call
sites degrade closed and log: roots resolve to an empty set with a warning
naming the remedy (`src/core/registrar.ts`), and a thrown elicitation is
treated as a denial (`src/core/path.ts`). Revisit when 2026-07-28 becomes the
negotiated default.

**No `logging` capability.** SEP-2577 deprecates the subsystem, and every
diagnostic in this server goes to stderr rather than
`notifications/message`. Advertising `logging` would promise a
`logging/setLevel` that changes nothing.

**Hand-wired transport, not `createMcpHandler`.** `startHttpServer` composes
`NodeStreamableHTTPServerTransport` with its own `HttpSessionRegistry` because
the 2025-era session model (sweep timer, per-session `PathGuard`, resumable
event store) needs state `createMcpHandler` does not expose. Cost: HTTP tests
bind a real TCP port instead of calling `handler.fetch` in-process.

## Configuration

**CLI flags are lifted into `process.env` before any config-bearing import.**
`src/index.ts` runs a non-strict pre-parse of `argv` and copies `--http-host`,
`--api-key`, `--log-level`, `--max-file-size`, `--root-boundary`,
`--allow-sensitive`, and `--deny` into their env vars. This has to happen
before the dynamic imports, because `core/util.ts` freezes `LOG_LEVEL` and
`MAX_FILE_SIZE` into module-level constants at import time. `cli.ts` still owns
strict validation and error messages; the pre-parse only copies values.

## Security

**Fail-closed binding policy.** A non-loopback bind requires an `API_KEY` of at
least 16 characters (`assertHttpBindingPolicy`). A wildcard bind (`0.0.0.0`,
`::`) additionally requires an explicit `FILESYSTEM_MCP_ALLOWED_HOSTS` list,
because clients never send `Host: 0.0.0.0` and defaulting the allowed set to
the bind string would reject all real traffic. `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1`
accepts that risk explicitly and warns.

**Loopback binds allow all three localhost spellings.** `localhost`,
`127.0.0.1`, and `[::1]` — via the SDK's `localhostAllowedHostnames()`. A bare
`[bindAddress]` list would 403 the URL users actually type.

**Bearer auth is a single shared static key, with no RFC 9728 metadata.** The
`401` carries `WWW-Authenticate: Bearer` without a `resource_metadata`
parameter, because there is no authorization server and no protected-resource
document to point a client at. Adding the parameter pointing at nothing would
be worse than omitting it. Revisit together with any move to real OAuth.

**`API_KEY` is the supported channel for the key; `--api-key` is for local
development.** Both work and the flag wins, but argv is world-readable through
`ps` on a shared host and is captured by shell history, so a production secret
belongs in the environment. `--help` says so at the flag.

**TOCTOU ceiling on path checks.** `PathGuard` resolves through `realpath` and
re-checks symlinks after opening, but a sufficiently fast attacker with write
access inside an allowed root can still win the race between check and use. See
the comment at `src/core/path.ts` for the exact window. Closing it fully needs
`openat`-style handle-relative syscalls, which Node does not expose.
