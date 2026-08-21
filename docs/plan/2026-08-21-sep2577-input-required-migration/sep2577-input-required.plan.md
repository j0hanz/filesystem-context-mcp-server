# Plan: migrate destructive confirmations to input_required

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `cf4f255`, 2026-08-21. Amended 2026-08-21 after
> Step 8 STOPped (Steps 1–7 are executed — see
> [`sep2577-input-required.run.md`](sep2577-input-required.run.md)); the
> amendment adds the validation-gap files and the wire-test rewrite the STOP
> surfaced. A cold executor starts at **Step 8**.
> **Drift check (run first)**: `git diff --stat cf4f255..HEAD -- src/tools src/core/path.ts src/server.ts src/cli.ts README.md __tests__/helpers.ts __tests__/security.test.ts __tests__/tools/directory.test.ts __tests__/tools/read-write.test.ts __tests__/tools/stat.test.ts __tests__/unit/corehandler-return-type.test.ts`
> Its file list narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

Move the server's destructive-confirmation flows (recursive delete, move overwrite,
out-of-root access grant) from the deprecated push-style `elicitInput` to the
`input_required` multi-round-trip result so they work on the 2026-07-28 protocol
era, and remove the `elicitInput` surface from those flows. Today `elicitInput`
throws on the modern era and the server degrades (delete proceeds unprompted, move
fails closed, access-grant silently denies); after this, a human's explicit accept is
required before anything destructive happens, batched into one round-trip per call.
Requirements covered: [`R1`–`R14`](sep2577-input-required.spec.md#requirements) as
amended by [`spec-delta`](sep2577-input-required.spec-delta.md). Roots
`listRoots()` and the era-reject pin are out of scope (separate spec).

## Current state

The control flow is imperative-elicitation: `elicitInput` is called mid-`run` and
from a nested callback, resolving in-round. `input_required` is a **return value**
— the handler returns it, the client retries the same `tools/call` with
`inputResponses`, and the handler re-enters from the top. Every step below replaces
imperative-ask with top-of-`run` pre-check → return → re-entry read.

- [`src/tools/define.ts:36-48`](../../../src/tools/define.ts#L36-L48) — `ToolCtx`
  carries `elicitInput?: (params) => Promise<ElicitResult>`. Thread `inputResponses`
  and a `requestState` accessor here instead.
- [`src/tools/define.ts:114-143`](../../../src/tools/define.ts#L114-L143) —
  `confirmBoolean` builds a one-field form and calls `elicitInput`. Used by delete,
  move, and the access-grant handler. Removed in Step 6.
- [`src/tools/define.ts:147-179`](../../../src/tools/define.ts#L147-L179) —
  `toToolCtx` wires `elicitInput: (params) => ctx.mcpReq.elicitInput(params)` (the
  deprecated push). Replace with `inputResponses: ctx.mcpReq.inputResponses` and
  `requestState: ctx.mcpReq.requestState`.
- [`src/tools/define.ts:317-356`](../../../src/tools/define.ts#L317-L356) —
  `buildAccessDeniedHandler` reads `getClientCapabilities()` for the `elicitation`
  cap, then builds a `confirm` callback that `PathGuard.requestAccessGrant` invokes
  deep inside fs ops. This is the access-grant rearchitecture site (Step 5).
- [`src/tools/define.ts:358-404`](../../../src/tools/define.ts#L358-L404) —
  `execute()` returns `Promise<CallToolResult>`; `run` returns
  `Promise<RunResult<O>>`; `createServerToolHandler` returns
  `(args, ctx) => Promise<CallToolResult>`. All three widen to
  `| InputRequiredResult` (Step 2).
- [`src/tools/delete-file.ts:102-131`](../../../src/tools/delete-file.ts#L102-L131)
  — `tryElicitConfirmation` calls `confirmBoolean` per path, mid-batch.
- [`src/tools/delete-file.ts:149-200`](../../../src/tools/delete-file.ts#L149-L200)
  — `deleteSinglePath` stats, then confirms, then deletes — per path, in parallel
  via `handleDelete` ([`:245`](../../../src/tools/delete-file.ts#L245)).
- [`src/tools/move.ts:63-104`](../../../src/tools/move.ts#L63-L104) —
  `tryElicitOverwriteConfirmation` calls `confirmBoolean` per move, mid-loop
  ([`:285`](../../../src/tools/move.ts#L285)).
- [`src/server.ts:108-111`](../../../src/server.ts#L108-L111) — `serverConfig`
  (`ServerOptions`) is where `requestState.verify` is configured (Step 1).

SDK API (confirmed against
[`createMcpHandler-CLhGwQTn.d.mts`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts)):

- `inputRequired({ inputRequests, requestState })` → `InputRequiredResult`
  ([`:1400`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L1400)).
  `inputRequired.elicit({ message, requestedSchema })` → an `InputRequest`
  ([`:1409`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L1409)).
- `acceptedContent<T>(ctx.mcpReq.inputResponses, key)` reads an accepted response,
  `undefined` if missing/declined/cancelled
  ([`:1459`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L1459));
  `inputResponse(responses, key)` gives the discriminated view
  (`accept|decline|cancel|missing`)
  ([`:1481`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L1481)).
- `createRequestStateCodec` is the SDK HMAC helper; its `verify` drops into
  `ServerOptions.requestState.verify`, and `mint<T>`/`ctx.mcpReq.requestState<T>()`
  are the typed encode/read pair
  ([`:2854-2871`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L2854-L2871)).
- `HandlerResultTypeMap` admits `InputRequiredResult` for `tools/call`
  ([`:747`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L747)).

### Era constraint (verified empirically 2026-08-21 — load-bearing for Step 10)

A raw `input_required` result is a **2026-era wire behavior only**. The installed
SDK (`@modelcontextprotocol/server` + `client`, v2) cannot negotiate the 2026-07-28
era over `InMemoryTransport`:

- `LATEST_PROTOCOL_VERSION = "2025-11-25"` and `SUPPORTED_PROTOCOL_VERSIONS` is
  `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]` in BOTH
  packages. `2026-07-28` appears only in README prose, never in a version
  constant, so `versionNegotiation: { mode: 'auto' }` (even with the server AND
  client both advertising `2026-07-28` in `supportedProtocolVersions`) still
  negotiates `getNegotiatedProtocolVersion() = "2025-11-25"`,
  `getProtocolEra() = "legacy"`, `getDiscoverResult() = undefined`.
- The SDK's own doc
  ([`createMcpHandler-CLhGwQTn.d.mts:2807-2831`](../../../node_modules/@modelcontextprotocol/server/dist/createMcpHandler-CLhGwQTn.d.mts#L2807-L2831)):
  on 2025-era connections the `inputRequired.legacyShim` (default `true`) fulfils
  an `input_required` return **server-side** via real `elicitation/create`
  pushes + handler re-entry; `legacyShim: false` fails loudly. Either way a wire
  caller never observes `isInputRequiredResult(raw) === true` on a 2025-era
  connection.

Consequence, observed over `InMemoryTransport` with the existing
`createTestEnv` harness (legacy client, no `elicitation` capability): an
out-of-root tool call returns a fail-closed error result, NOT `input_required`
and NOT `ACCESS_DENIED`:

```text
isError: true
content[0].text: "Cannot request input 'confirm_0' (elicitation/create): the
                  client on this 2025-era connection did not declare the required
                  capability"
```

The message is minted at
[`mcp-DXXb3Vv3.mjs:561`](../../../node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs#L561)
in the legacy shim's missing-capability path. This is the only stable, assertable
out-of-root behavior reachable over the wire with the installed SDK, and it is
fail-closed (R6: no accepted confirmation → no filesystem touch). The real
`input_required` round-trip is covered where it can be — the direct-handler tests
(`elicitation-era`, `delete-file`, `move`, `access-grant`, `elicitation`) drive the
handler with a fake `ServerContext` and pass. Step 10 rewrites the wire tests to
assert this fail-close; it does NOT attempt a 2026-era discover upgrade (proven
impossible above).

### Files the amendment adds (Current state excerpts)

- [`__tests__/helpers.ts:64-113`](../../../__tests__/helpers.ts#L64-L113) —
  `createTestEnv`: `new McpServer({name:'test-server',version:'0.0.0'}, {capabilities:{…}})`
  with no `supportedProtocolVersions`; `new Client({name:'test-client',version:'1.0.0'})`
  with no `versionNegotiation`; `InMemoryTransport.createLinkedPair()`; `server.connect`
  then `client.connect`; `pathGuard.setRoots([tmpDir])`. Step 10 adds an
  `assertInputRequiredFailClose` helper here (the harness era config is UNCHANGED —
  the legacy era is exactly what makes the fail-close observable).
- [`__tests__/helpers.ts:196-237`](../../../__tests__/helpers.ts#L196-L237) —
  `assertOk`/`assertToolError`/`getStructured` helpers. Add `assertInputRequiredFailClose`
  alongside, matching their style.
- [`src/cli.ts:178-200`](../../../src/cli.ts#L178-L200) — `export const ENV_HELP: HelpRow[]`
  rows; Step 1's `FILESYSTEM_MCP_REQUEST_STATE_KEY` (read in
  [`input-required.ts:56-63`](../../../src/tools/input-required.ts#L56-L63) via
  `process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY']`) has no row here. Step 8 adds one.
- [`README.md:367-394`](../../../README.md#L367-L394) — the "Environment variables"
  table; each row is ``| `VAR` | <purpose> |``. Step 8 adds the matching row.
- [`__tests__/unit/corehandler-return-type.test.ts:22`](../../../__tests__/unit/corehandler-return-type.test.ts#L22)
  — `/async execute\(deps: ToolDeps\): Promise<CallToolResult>/`; and
  [`:36`](../../../__tests__/unit/corehandler-return-type.test.ts#L36) —
  `/function createServerToolHandler<[^>]+>\([\s\S]*?\): \(args: z\.infer<I>, ctx: ServerContext\) => Promise<CallToolResult>/`.
  Step 2 widened `execute`/`createServerToolHandler` to `Promise<CallToolResult | InputRequiredResult>`,
  so both regexes now miss. Step 9 widens them.
- [`__tests__/unit/env-documented.test.ts:24-45`](../../../__tests__/unit/env-documented.test.ts#L24-L45)
  — the GATE test (not edited): walks `src/` for `process.env['NAME']` reads and
  requires each (except `NODE_ENV`) in `ENV_HELP`; then
  [`:47-57`](../../../__tests__/unit/env-documented.test.ts#L47-L57) requires every
  `ENV_HELP` `flags` row to appear backtick-wrapped in README. Step 8 satisfies both.
- [`__tests__/security.test.ts:49-78`](../../../__tests__/security.test.ts#L49-L78) —
  "path boundary enforcement" loops 8 tools, asserting `ACCESS_DENIED` via branched
  structured-content checks. All 8 now fail-close. And
  [`:95-137`](../../../__tests__/security.test.ts#L95-L137) — "path traversal via .."
  (read/stat/create via `join(env.tmpDir, '..', …)`; `join` resolves `..` so the path
  reaches `precheckGrant`), 3 tests asserting `ACCESS_DENIED`. The symlink-escape
  ([`:142-189`](../../../__tests__/security.test.ts#L142-L189),
  [`:275-391`](../../../__tests__/security.test.ts#L275-L391)), sensitive
  ([`:395-425`](../../../__tests__/security.test.ts#L395-L425)), list-hides-symlinks
  ([`:429-473`](../../../__tests__/security.test.ts#L429-L473)), and schema
  ([`:193-271`](../../../__tests__/security.test.ts#L193-L271)) tests use in-root or
  schema-rejected paths → era-agnostic → PASS, untouched. The
  [`list: rejects paths outside allowed directories`](../../../__tests__/security.test.ts#L256-L262)
  `/../` case is schema-rejected (literal `..` forbidden by `PathBase`) → untouched.
- [`__tests__/tools/directory.test.ts:203-209`](../../../__tests__/tools/directory.test.ts#L203-L209)
  — list `/etc` → `assertToolError(raw, 'ACCESS_DENIED')`;
  [`:447-462`](../../../__tests__/tools/directory.test.ts#L447-L462) — create
  `/tmp/escape-${Date.now()}` → structured `failures[0].code === 'ACCESS_DENIED'`;
  [`:517-544`](../../../__tests__/tools/directory.test.ts#L517-L544) — recursive
  delete of an in-root non-empty dir → asserts `ok:true` + dir gone. The
  [`returns ACCESS_DENIED when deleting workspace root`](../../../__tests__/tools/directory.test.ts#L569)
  case (`env.tmpDir`) passes — that's `isAllowedRoot` inside delete, not `precheckGrant`.
- [`__tests__/tools/read-write.test.ts:126-136`](../../../__tests__/tools/read-write.test.ts#L126-L136)
  — read `/etc/hostname` → `results[0].error.code === 'ACCESS_DENIED'`;
  [`:365-375`](../../../__tests__/tools/read-write.test.ts#L365-L375) — create
  `/tmp/escape.txt` → `failures[0].error.code === 'ACCESS_DENIED'`;
  [`:398-433`](../../../__tests__/tools/read-write.test.ts#L398-L433) — mixed batch
  `good1 + /tmp/escape-bad.txt + good2` → asserts both goods created + 1 failure. Under
  R14 the whole batch round-trips atomically, so round 1 creates nothing.
- [`__tests__/tools/stat.test.ts:110-122`](../../../__tests__/tools/stat.test.ts#L110-L122)
  — stat `/etc/passwd` → `results[0].error.code === 'ACCESS_DENIED'`.

Conventions to match:

- Errors follow the `Problem`/`FsError` + `ErrorCode` pattern; a cancelled item
  uses `ErrorCode.CANCELLED` — exemplar
  [`delete-file.ts:195`](../../../src/tools/delete-file.ts#L195),
  [`move.ts:89`](../../../src/tools/move.ts#L89).
- Tools are defined with `defineTool` and return `RunResult<O>`; the executor
  builds the `CallToolResult` — exemplar
  [`define.ts:223-230`](../../../src/tools/define.ts#L223-L230).
- zod schemas via `import * as z from 'zod/v4'` — exemplar
  [`define.ts:1`](../../../src/tools/define.ts#L1).
- Tests use `node:test` (`describe`/`it`) with a fake `ServerContext` — exemplar
  [`__tests__/tools/elicitation-era.test.ts`](../../../__tests__/tools/elicitation-era.test.ts).
- Test-harness assertion helpers live in
  [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) (`assertOk`, `assertToolError`,
  `getStructured`); a new wire-level helper follows their shape.

## Commands

| Purpose          | Command                                                                                                                                                                            | Expected on success     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Static check     | `node scripts/tasks.mjs --quick`                                                                                                                                                   | exit 0, all phases pass |
| Env-doc gate     | `node --test --import tsx "__tests__/unit/env-documented.test.ts"`                                                                                                                 | all pass                |
| coreHandler test | `node --test --import tsx "__tests__/unit/corehandler-return-type.test.ts"`                                                                                                        | all pass                |
| Wire out-of-root | `node --test --import tsx "__tests__/security.test.ts" "__tests__/tools/directory.test.ts" "__tests__/tools/read-write.test.ts" "__tests__/tools/stat.test.ts"`                    | all pass                |
| Affected tests   | `node --test --import tsx "__tests__/tools/elicitation-era.test.ts" "__tests__/tools/delete-file.test.ts" "__tests__/tools/move.test.ts" "__tests__/unit/http-auth-guard.test.ts"` | all pass                |
| Full suite       | `node scripts/tasks.mjs`                                                                                                                                                           | all pass                |

Baseline at `cf4f255`: static check passes; affected tests pass (4/4); full suite
presumed green on a clean tree.

## Scope

**In scope** — the only files to modify:

- [`src/tools/define.ts`](../../../src/tools/define.ts) — `ToolCtx`, `confirmBoolean`, `toToolCtx`, executor return types, `buildAccessDeniedHandler`.
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) — confirmation pre-check + round-trip.
- [`src/tools/move.ts`](../../../src/tools/move.ts) — overwrite confirmation pre-check + round-trip.
- [`src/core/path.ts`](../../../src/core/path.ts) — `PathGuard` access-grant pre-check (Step 5).
- [`src/server.ts`](../../../src/server.ts) — `requestState` codec config.
- New `src/tools/input-required.ts` — shared `inputRequired` helpers + requestState codec binding (Step 1).
- [`__tests__/tools/elicitation-era.test.ts`](../../../__tests__/tools/elicitation-era.test.ts) — rewrite for round-trip.
- [`__tests__/tools/delete-file.test.ts`](../../../__tests__/tools/delete-file.test.ts) — round-trip + atomic-batch tests.
- [`__tests__/tools/move.test.ts`](../../../__tests__/tools/move.test.ts) — round-trip tests.
- Access-grant test (new or in [`__tests__/unit/http-auth-guard.test.ts`](../../../__tests__/unit/http-auth-guard.test.ts)) — Step 5.
- [`src/cli.ts`](../../../src/cli.ts) — `ENV_HELP` row for `FILESYSTEM_MCP_REQUEST_STATE_KEY` (Step 8).
- [`README.md`](../../../README.md) — matching "Environment variables" table row (Step 8).
- [`__tests__/unit/corehandler-return-type.test.ts`](../../../__tests__/unit/corehandler-return-type.test.ts) — widen the return-type regexes (Step 9).
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts) — `assertInputRequiredFailClose` helper (Step 10).
- [`__tests__/security.test.ts`](../../../__tests__/security.test.ts) — rewrite out-of-root/traversal assertions to the legacy-era fail-close (Step 10).
- [`__tests__/tools/directory.test.ts`](../../../__tests__/tools/directory.test.ts) — rewrite out-of-root + recursive-rm assertions (Step 10).
- [`__tests__/tools/read-write.test.ts`](../../../__tests__/tools/read-write.test.ts) — rewrite out-of-root + mixed-batch assertions (Step 10).
- [`__tests__/tools/stat.test.ts`](../../../__tests__/tools/stat.test.ts) — rewrite out-of-root assertion (Step 10).

**Files out of scope** — leave alone:

- [`src/core/registrar.ts`](../../../src/core/registrar.ts) — `listRoots()` / `getClientCapabilities()` in the roots path belong to the roots spec; the `eslint-disable` blocks there stay.
- [`src/transport.ts`](../../../src/transport.ts) — no `legacy` flag (server uses `NodeStreamableHTTPServerTransport`, not `createMcpHandler`); era-reject pin is the roots spec.
- [`src/resources.ts`](../../../src/resources.ts), [`src/prompts.ts`](../../../src/prompts.ts) — no current elicitation usage (spec out of scope).
- [`__tests__/unit/env-documented.test.ts`](../../../__tests__/unit/env-documented.test.ts) — the GATE test; Step 8 makes it pass by adding the env var to `cli.ts` + `README.md`, not by editing the test.
- `package.json` / `server.json` versions — bumped only by the Release workflow; never hand-edited.

## Steps

### 1. Add input_required infrastructure (additive, no behavior change)

Create `src/tools/input-required.ts` exporting:

- A `createRequestStateCodec`-backed codec for the pending-operation shape
  `{ op: 'delete' | 'move' | 'grant'; paths: string[] }` (sorted), minted with an
  HMAC secret read once from process state (generate a random secret at boot if
  none — never hard-code). `verify` throws on tamper/expiry.
- `buildInputRequired(pending)` — takes a list of `{ key, message, requestedSchema }`
  and returns `inputRequired({ inputRequests: { [key]: inputRequired.elicit({...}) }, requestState: codec.mint({...}) })`.
- `readAccepted(ctx, key)` — wraps `acceptedContent`/`inputResponse` for one key.

In [`src/server.ts`](../../../src/server.ts) `serverConfig` ([`:108`](../../../src/server.ts#L108)),
add `requestState: { verify: codec.verify }`. In [`define.ts`](../../../src/tools/define.ts)
`toToolCtx` ([`:147`](../../../src/tools/define.ts#L147)), add
`inputResponses: ctx.mcpReq.inputResponses` and
`requestState: ctx.mcpReq.requestState` to `ToolCtx` ([`:36`](../../../src/tools/define.ts#L36)).
Do **not** remove `elicitInput` yet (Step 6).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0. (No behavior change; no new
tests yet — the helpers are exercised from Step 3 on.)

### 2. Widen the tool return type to allow InputRequiredResult (additive)

In [`define.ts`](../../../src/tools/define.ts): widen `ToolDef.run`
([`:74`](../../../src/tools/define.ts#L74)) to
`Promise<RunResult<O> | InputRequiredResult>`; widen `execute()`
([`:358`](../../../src/tools/define.ts#L358)) and `executeTool`/`createServerToolHandler`
([`:389-404`](../../../src/tools/define.ts#L389-L404)) to
`Promise<CallToolResult | InputRequiredResult>`. In `execute`'s `runTool`
([`:366`](../../../src/tools/define.ts#L366)), if `run` returns an
`InputRequiredResult`, skip `completeProgress` and return it verbatim (progress
is not "done"; the call is paused). Import `InputRequiredResult` and `inputRequired`
from `@modelcontextprotocol/server`.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0. Affected tests → all pass
(no tool returns input_required yet).

### 3. Migrate delete-file to input_required (R1, R3, R4, R5, R6, R13, R14 — delete)

Write the tests first (tdd), then the code.

Test shape (in [`delete-file.test.ts`](../../../__tests__/tools/delete-file.test.ts)):
a fake `ServerContext` whose `mcpReq.inputResponses` is `undefined` on the first
call and `{ confirm_<idx>: { action:'accept', content:{ confirm:true } } }` on the
retry; assert the first call returns `input_required` and the dir still exists, the
retry deletes it; a `decline` retry leaves the dir and reports `CANCELLED`; a
mixed `[file, nonEmptyDir]` call deletes nothing in round 1 and both on accept
(R14).

Restructure [`handleDelete`](../../../src/tools/delete-file.ts#L245): before any
deletion, pre-check every path — `validatePathForDelete`, `lstat`, and (for
recursive dirs) `hasChildrenUnchecked` — to build the pending set (recursive +
non-empty dir). If the pending set is non-empty and `ctx.inputResponses` does not
yet hold an accepted response for every pending key, return
`buildInputRequired(pending)` with `op:'delete'`, `paths` = the call's paths.
Atomic (R14): delete nothing in round 1. On retry, `readAccepted` per pending key:
accepted or non-pending → delete (via the existing `performDeletion`/TOCTOU path);
declined/cancelled/missing → `Problem.cancelled` for that path. Replace
`tryElicitConfirmation`'s `confirmBoolean` path; delete it.

**Verify**: `node --test --import tsx "__tests__/tools/delete-file.test.ts"` → all pass, including new round-trip + atomic-batch tests. `node scripts/tasks.mjs --quick` → exit 0.

### 4. Migrate move overwrite to input_required (R1–R5, R13, R14 — move)

Tests first: overwrite-confirmed round-trip proceeds; declined leaves dest and
throws/reports `CANCELLED`; mixed batch atomic.

Restructure [`handleMove`](../../../src/tools/move.ts) (the `run` at
[`:233`](../../../src/tools/move.ts#L233)): pre-check all `args.moves` — resolve
dest, `stat` for existence — to build the pending overwrite set before moving
anything. If pending and no accepted responses, return `buildInputRequired` with
`op:'move'`, `paths` = destinations. On retry, accepted → overwrite; declined →
`FsError(CANCELLED)` per item. Atomic. Remove `tryElicitOverwriteConfirmation`'s
`confirmBoolean` call.

**Verify**: `node --test --import tsx "__tests__/tools/move.test.ts"` → all pass. `node scripts/tasks.mjs --quick` → exit 0.

### 5. Migrate access-grant to a pre-check (R7, R8, R9)

This is the architectural step. Today `PathGuard.requestAccessGrant` invokes a
`confirm` callback **inside** fs ops; that cannot return `input_required`. Replace
it with a **pre-check**: before a tool performs fs ops, it asks `PathGuard` which
target paths are out-of-root; if any are, the tool returns `buildInputRequired` with
`op:'grant'`, `paths` = out-of-root paths, **before** touching the filesystem
(R7). On retry with `accept`, `PathGuard` adds the granted path to its allowed
directories for the session (R8) and the operation proceeds; `requestState` binds
the granted path so a grant accepted for X cannot authorize Y (R9).

Concrete: in [`path.ts`](../../../src/core/path.ts) `PathGuard`, add a
`precheckAccess(paths): string[]` returning out-of-root paths (no callback), and
`applyGrant(path)` adding to allowed dirs. Remove the
`runWithAccessDeniedHandler`/`requestAccessGrant({ confirm })` callback model. In
[`define.ts`](../../../src/tools/define.ts) `buildAccessDeniedHandler`
([`:317`](../../../src/tools/define.ts#L317)), replace it with a pre-check hook the
executor calls before `run` (or fold the pre-check into each tool's `run`).
Remove the `getClientCapabilities` cap gate ([`:322-335`](../../../src/tools/define.ts#L322-L335))
— `input_required` needs no client `elicitation` capability advertisement.

Tests: out-of-root read returns `input_required`, path unread; accept retry reads
and a second call on the same path reads without re-prompt (R8); a grant for X
rejected when retried with params naming Y (R9).

**Verify**: `node --test --import tsx "__tests__/unit/http-auth-guard.test.ts"` → all pass. `node scripts/tasks.mjs --quick` → exit 0.

### 6. Remove elicitInput, confirmBoolean, and the destructive eslint-disable blocks (R11)

After Steps 3–5, no destructive flow uses `elicitInput`/`confirmBoolean`. Remove
from [`define.ts`](../../../src/tools/define.ts): the `elicitInput` field on
`ToolCtx` ([`:46`](../../../src/tools/define.ts#L46)), the `elicitInput` wiring in
`toToolCtx` ([`:169-176`](../../../src/tools/define.ts#L169-L176)), `confirmBoolean`
([`:114-143`](../../../src/tools/define.ts#L114-L143)), and `isElicitationUnavailable`
if now unused. Grep to confirm:

`grep -rn "elicitInput\|confirmBoolean\|isElicitationUnavailable" src/` returns only
`src/core/registrar.ts` (roots — out of scope, stays) or nothing.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0 (no `no-deprecated` warnings from the destructive path). `grep -rn "elicitInput" src/tools` → no matches.

### 7. Rewrite the elicitation-era test for the round-trip (R1–R14)

[`__tests__/tools/elicitation-era.test.ts`](../../../__tests__/tools/elicitation-era.test.ts)
today asserts the 2026-era _degradation_ (elicitInput throws → delete proceeds /
move fails). Replace with: on a connection with no elicitation capability, a
destructive call returns `input_required` (not a throw, not a silent proceed), and
the filesystem is unchanged until an accepted retry (R6 fail-closed). The fake
`ServerContext` supplies `mcpReq.inputResponses` across two calls instead of a
throwing `elicitInput`.

**Verify**: `node --test --import tsx "__tests__/tools/elicitation-era.test.ts" "__tests__/tools/delete-file.test.ts" "__tests__/tools/move.test.ts" "__tests__/unit/http-auth-guard.test.ts"` → all pass.

### 8. Document the FILESYSTEM_MCP_REQUEST_STATE_KEY env var

Step 1 reads `FILESYSTEM_MCP_REQUEST_STATE_KEY` in
[`input-required.ts:56-63`](../../../src/tools/input-required.ts#L56-L63); the
[`env-documented.test.ts`](../../../__tests__/unit/env-documented.test.ts) gate
requires every `process.env['NAME']` read in `src/` to have an `ENV_HELP` row, and
every `ENV_HELP` row to appear backtick-wrapped in the README env table. Add both
in one step (either alone fails the other gate):

- In [`src/cli.ts`](../../../src/cli.ts) `ENV_HELP` ([`:178`](../../../src/cli.ts#L178)),
  add a row in the existing shape:
  `{ flags: 'FILESYSTEM_MCP_REQUEST_STATE_KEY', desc: 'HMAC key sealing input_required requestState across retry rounds (UTF-8, >=32 bytes; random per boot if unset)' }`.
- In [`README.md`](../../../README.md) "Environment variables" table
  ([`:367-394`](../../../README.md#L367-L394)), add a row in the existing shape:
  ``| `FILESYSTEM_MCP_REQUEST_STATE_KEY` | HMAC key sealing `input_required` requestState across retry rounds (UTF-8, >=32 bytes; random per boot if unset). |``

Do NOT edit `env-documented.test.ts` — it is the gate, not the fix.

**Verify**: `node --test --import tsx "__tests__/unit/env-documented.test.ts"` → both tests pass. `node scripts/tasks.mjs --quick` → exit 0.

### 9. Widen the coreHandler return-type test to `| InputRequiredResult`

Step 2 widened `execute` and `createServerToolHandler` in
[`define.ts`](../../../src/tools/define.ts) to
`Promise<CallToolResult | InputRequiredResult>`
([`:327`](../../../src/tools/define.ts#L327),
[`:376`](../../../src/tools/define.ts#L376)). The regex test in
[`__tests__/unit/corehandler-return-type.test.ts`](../../../__tests__/unit/corehandler-return-type.test.ts)
still asserts `Promise<CallToolResult>` only:

- [`:22`](../../../__tests__/unit/corehandler-return-type.test.ts#L22): widen
  `/async execute\(deps: ToolDeps\): Promise<CallToolResult>/` to
  `/async execute\(deps: ToolDeps\): Promise<CallToolResult \| InputRequiredResult>/`.
- [`:36`](../../../__tests__/unit/corehandler-return-type.test.ts#L36): widen the
  `createServerToolHandler` regex's trailing `=> Promise<CallToolResult>/` to
  `=> Promise<CallToolResult | InputRequiredResult>/`.

Do NOT add an `InputRequiredResult` import: the symbol appears only inside the regex
literals (not as a referenced identifier), so an unused import would trip
`@typescript-eslint/no-unused-vars` (error for test files —
[`eslint.config.mjs:57-58`](../../../eslint.config.mjs#L57-L58)) and fail the
`--quick` lint gate. The regex widening alone is the fix.

**Verify**: `node --test --import tsx "__tests__/unit/corehandler-return-type.test.ts"` → both tests pass. `node scripts/tasks.mjs --quick` → exit 0.

### 10. Rewrite out-of-root wire tests for the legacy-era fail-close (R6, R14)

Over the `createTestEnv` wire harness (legacy `2025-11-25` era, no `elicitation`
capability), an out-of-root tool call no longer returns `ACCESS_DENIED` — Step 5's
`precheckGrant` returns `input_required`, and the SDK legacy shim fail-closes with
`isError: true` + `"…did not declare the required capability"` (the era constraint
above). This is R6 fail-closed over the wire; nothing is touched. Rewrite the 20
affected wire assertions to assert that fail-close. The real round-trip stays
covered by the passing direct-handler tests.

First add a shared helper in [`__tests__/helpers.ts`](../../../__tests__/helpers.ts)
beside [`assertToolError`](../../../__tests__/helpers.ts#L196-L237):

```ts
/**
 * Over the legacy-era wire harness (no elicitation capability), an out-of-root
 * call returns input_required and the SDK legacy shim fail-closes: isError:true
 * with the missing-capability message (R6 — nothing on disk is touched). Asserts
 * that fail-close shape. Not a raw input_required — see the plan's era constraint.
 */
export function assertInputRequiredFailClose(raw: {
  isError?: boolean;
  content?: { text?: string }[];
}): void {
  assert.equal(
    raw.isError,
    true,
    'out-of-root call must fail-closed (isError) on the legacy-era harness',
  );
  const text = raw.content?.[0]?.text ?? '';
  assert.ok(
    text.includes('did not declare the required capability'),
    `expected legacy-era fail-close message, got: ${text}`,
  );
}
```

Then rewrite each file. Leave every test NOT listed here untouched (they use
in-root or schema-rejected paths and pass era-agnostically):

- [`__tests__/security.test.ts`](../../../__tests__/security.test.ts):
  - Boundary loop ([`:49-78`](../../../__tests__/security.test.ts#L49-L78)): replace
    the whole branched `if (delete||create) … else if (read||stat) … else assertToolError`
    body with `assertInputRequiredFailClose(raw)` for all 8 tools.
  - Traversal read/stat/create ([`:95-137`](../../../__tests__/security.test.ts#L95-L137)):
    replace each `assertOk(raw)` + `results[0]?.error?.code === 'ACCESS_DENIED'`
    (and the create `failures[0]` variant) with `assertInputRequiredFailClose(raw)`.
- [`__tests__/tools/directory.test.ts`](../../../__tests__/tools/directory.test.ts):
  - list `/etc` ([`:203-209`](../../../__tests__/tools/directory.test.ts#L203-L209)):
    `assertInputRequiredFailClose(raw)` (drop `assertToolError(raw, 'ACCESS_DENIED')`).
  - create `/tmp/escape-${Date.now()}` ([`:447-462`](../../../__tests__/tools/directory.test.ts#L447-L462)):
    capture the escape path in a const, `assertInputRequiredFailClose(raw)`, then
    `assert.rejects(() => stat(escapePath), /ENOENT/)` — R6, nothing created.
  - recursive rm ([`:517-544`](../../../__tests__/tools/directory.test.ts#L517-L544)):
    `assertInputRequiredFailClose(raw)`, then assert `await stat(dir)` still
    resolves AND `await readFile(join(dir, 'inner.txt'), 'utf8')` still reads
    `'inner'` — R6, the non-empty recursive delete fail-closed without a retry.
- [`__tests__/tools/read-write.test.ts`](../../../__tests__/tools/read-write.test.ts):
  - read `/etc/hostname` ([`:126-136`](../../../__tests__/tools/read-write.test.ts#L126-L136)):
    `assertInputRequiredFailClose(raw)`.
  - create `/tmp/escape.txt` ([`:365-375`](../../../__tests__/tools/read-write.test.ts#L365-L375)):
    `assertInputRequiredFailClose(raw)` + `assert.rejects(() => stat('/tmp/escape.txt'), /ENOENT/)`.
  - mixed batch ([`:398-433`](../../../__tests__/tools/read-write.test.ts#L398-L433)):
    `assertInputRequiredFailClose(result)` + `assert.rejects(() => stat(good1), /ENOENT/)`
    - `assert.rejects(() => stat(good2), /ENOENT/)` — R14 atomic, the whole batch
      round-trips so round 1 creates neither good file.
- [`__tests__/tools/stat.test.ts`](../../../__tests__/tools/stat.test.ts):
  - stat `/etc/passwd` ([`:110-122`](../../../__tests__/tools/stat.test.ts#L110-L122)):
    `assertInputRequiredFailClose(raw)`.

The harness era config in `createTestEnv` is UNCHANGED — the legacy era is exactly
what makes the fail-close observable, and the installed SDK cannot reach a modern
era (see the era constraint). Do not add `versionNegotiation`/`supportedProtocolVersions`
or an `allowInputRequired` option.

**Verify**: `node --test --import tsx "__tests__/security.test.ts" "__tests__/tools/directory.test.ts" "__tests__/tools/read-write.test.ts" "__tests__/tools/stat.test.ts"` → all pass. `node scripts/tasks.mjs --quick` → exit 0.

### 11. Full validation

**Verify**: `node scripts/tasks.mjs` → all phases pass (static + full test suite + rebuild). `git status` → only in-scope files modified.

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0, no `no-deprecated` warnings from `src/tools`.
- [ ] `grep -rn "elicitInput\|confirmBoolean" src/tools` returns no matches.
- [ ] `node --test --import tsx "__tests__/unit/env-documented.test.ts"` exits 0.
- [ ] `node --test --import tsx "__tests__/unit/corehandler-return-type.test.ts"` exits 0.
- [ ] `node --test --import tsx "__tests__/security.test.ts" "__tests__/tools/directory.test.ts" "__tests__/tools/read-write.test.ts" "__tests__/tools/stat.test.ts"` exits 0, with out-of-root cases asserting the legacy-era fail-close and (recursive-rm, create-outside, mixed-batch) asserting the filesystem is untouched.
- [ ] `node --test --import tsx "__tests__/tools/elicitation-era.test.ts" "__tests__/tools/delete-file.test.ts" "__tests__/tools/move.test.ts" "__tests__/unit/http-auth-guard.test.ts"` exits 0, including new tests for: round-trip accept (R3), decline→CANCELLED (R4), cancel/missing→declined (R5), fail-closed no-retry (R6), batch atomicity (R14), access-grant + session persistence (R7/R8), requestState tamper/mismatch reject (R9/R10), no-confirm no round-trip (R13).
- [ ] `node scripts/tasks.mjs` exits 0.
- [ ] `git status` shows no files outside the in-scope list (notably NOT `__tests__/unit/env-documented.test.ts`, `src/core/registrar.ts`, `src/transport.ts`, `package.json`, `server.json`).

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its excerpt
  (run the drift check first).
- A step's verification fails twice after one fix attempt — a second failure means
  the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file (notably `registrar.ts`,
  `transport.ts`, `env-documented.test.ts`, or the version fields in `package.json`/`server.json`).
- **Key assumption**: `PathGuard` can expose an out-of-root **pre-check** without
  performing the fs op, so the access-grant `input_required` is returned before
  any filesystem touch. If `PathGuard`'s validation is inseparable from performing
  the op, Step 5's design is false and the access-grant migration needs its own
  spec — stop and report.
- **Key assumption (revised)**: the wire out-of-root behavior reachable with the
  installed SDK is the legacy-era fail-close — `isError: true` + a content message
  containing `"did not declare the required capability"` (minted at
  [`mcp-DXXb3Vv3.mjs:561`](../../../node_modules/@modelcontextprotocol/server/dist/mcp-DXXb3Vv3.mjs#L561)),
  NOT a raw `input_required` and NOT `ACCESS_DENIED`. This was verified
  empirically: `LATEST_PROTOCOL_VERSION = "2025-11-25"`; no harness config
  (`versionNegotiation: { mode: 'auto' }`, with or without the client/server
  advertising `2026-07-28` in `supportedProtocolVersions`) reaches a modern era —
  `getProtocolEra()` stays `"legacy"`. If a wire out-of-root call instead returns
  `ACCESS_DENIED` or a raw `input_required`, the installed SDK has changed under
  us and Step 10's assertion must be revisited — stop and report.

## Notes

- A reviewer should scrutinize: the requestState HMAC secret lifecycle (Step 1),
  the atomic-batch ordering (Step 3/4 — nothing mutates in round 1), the PathGuard
  pre-check not touching the filesystem (Step 5), and the Step 10 fail-close
  assertion matching the SDK's exact legacy-shim message (a substring match is
  used deliberately — the full string carries the round-specific `confirm_0` key
  and the era tag, which are not stable targets).
- Era finding (load-bearing): the migration's `input_required` return-value model
  is a 2026-07-28 wire behavior. The installed SDK cannot negotiate 2026-07-28
  over `InMemoryTransport` (verified — see the era constraint in Current state),
  so wire tests assert the 2025-era fail-close, and the round-trip itself is
  proven by the direct-handler tests. If a future SDK release adds `2026-07-28` to
  its version constants, the wire tests could be upgraded to assert a raw
  `input_required` via `versionNegotiation: { mode: 'auto' }` + `callTool(…, { allowInputRequired: true })`
  — that is a separate follow-up, not this migration.
- Rollback: this is a single branch; `git checkout cf4f255 -- src/ __tests__/` and
  `git checkout -- docs/plan/2026-08-21-sep2577-input-required-migration/` revert the
  code (docs are additive, safe to keep). No production data or migration to roll
  back.
- Behavior change to flag in the PR: recursive delete is now fail-closed when the
  client never retries (was: proceed unprompted when `elicitInput` unavailable) —
  decision record A1, confirmed by the operator. Out-of-root calls over a
  no-elicitation-cap connection now fail-closed with a capability message rather
  than `ACCESS_DENIED` (the grant round-trip is initiated server-side; the legacy
  shim fail-closes it) — R6.
- Deferred (separate spec): roots `listRoots()` → lazy `inputRequired.listRoots()`,
  the `getClientCapabilities` removal in `registrar.ts`, and the
  `supportedProtocolVersions` era-reject pin. Also deferred: upgrading the wire
  tests to a 2026-era discover harness once the SDK ships `2026-07-28` in its
  version constants.
