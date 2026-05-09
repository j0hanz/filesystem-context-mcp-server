---
title: Progress Session Redesign
date: 2026-05-09
status: approved
type: design
---

## Context

Today, progress reporting and task-status updates are tangled inside [src/tools/tool-execution.ts](../../../src/tools/tool-execution.ts) (~1200 lines). Three concerns share one file:

1. A **pure session state machine** (`buildProgressSessionFromOnProgress`, `ToolProgressSession`).
2. **MCP / task fan-out** (`reportProgress` → `updateTaskStoreProgress` + `sendMcpProgressNotification`, `createProgressReporter` with rate-limit + monotonic guard).
3. A **task `AsyncLocalStorage`** (`taskContext`, `reportTaskStatus`) used by 2 call sites for status-only updates.

Symptoms:

- The "pure" session can't be unit-tested in isolation — its file imports `@modelcontextprotocol/server`, `RequestTaskStore`, etc., so any test pulls the whole transport tree.
- Two parallel "wrap a tool body" entry points exist: `runWithProgressSession` (new) and the legacy `withProgress` (used by `wrapToolHandler` when `registerStandardTool({ progressMessage })` is set).
- `ToolProgressSession` exposes four inconsistent verbs (`update` / `increment` / `complete` / `fail`).
- `reportTaskStatus` reaches a session via ALS, but every existing caller already has the session in lexical scope — the ALS isn't earning its keep.
- The "force `current` past `total`" trick in `complete`/`fail` is an MCP-display concern leaking into the pure session.

This redesign collapses the entanglement into a deep `ProgressSession` module with a real, sink-pluggable seam.

## Goals

- One coherent model: every tool that reports progress uses the same `ProgressSession`.
- Pure session is testable with no transport, no `McpServer`, no `createTestEnv()`.
- MCP and task-store reporting become **sinks** behind a single contract; future sinks (logging, OTel, test) plug in trivially.
- Rate-limit, monotonic-cursor, and terminal-event semantics live in exactly one place.
- MCP-specific display quirks live in the MCP sink, not in the pure session.
- The legacy `withProgress` and the `taskContext` ALS are deleted.

## Non-goals

- Changing observable MCP `notifications/progress` payloads (clients see the same wire shape).
- Changing task-store `'working'` status string formatting.
- Touching the task lifecycle in `registerStandardTool` (`'completed'` / `'failed'` transitions stay where they are).
- Rethinking `registerStandardTool({ progressMessage, completionMessage })` declarative knobs — they stay.
- Touching the per-tool `nuances`/`gotchas` runtime help system.

## Architecture

Three named pieces:

| File                                                                          | Responsibility                                                                                                                                                                                                                | Imports                                                                 |
| :---------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| [src/lib/progress-session.ts](../../../src/lib/progress-session.ts) (new)     | `ProgressSession` class, `ProgressEvent` discriminated union, `ProgressSink` interface, monotonic + rate-limit logic, sink error guarding.                                                                                    | `node:*`, `Logger`                                                      |
| [src/tools/progress-sinks.ts](../../../src/tools/progress-sinks.ts) (new)     | `McpProgressSink`, `TaskStoreSink`, `progressSessionFromContext(ctx, opts)` bridge, the public helpers `runWithProgressSession` / `createBatchProgressCallbacks` / `completeProgressSession` / `resolveFinalProgressCurrent`. | `progress-session`, `@modelcontextprotocol/server`, `ToolContext` types |
| [src/tools/tool-execution.ts](../../../src/tools/tool-execution.ts) (slimmed) | Orchestration only. No progress state, no ALS, no `withProgress`. Re-exports the public progress helpers from `progress-sinks` to preserve current import paths.                                                              | unchanged minus deleted symbols                                         |

### Components

#### `ProgressSession` (pure, in `lib/`)

```ts
class ProgressSession {
  constructor(opts: { label: string; total?: number; sinks: ProgressSink[] });

  step(message: string): void;
  set(input: { current: number; total?: number; message?: string }): void;
  status(message: string): void;
  complete(message: string): void;
  fail(error: unknown, message?: string): void;

  readonly current: number;
}
```

- Constructor synchronously emits a `tick` event (`{ current: 0, total, message: label }`) so MCP clients see the start state — preserves today's observable behavior.
- `step` advances cursor by 1, emits `tick`.
- `set` advances cursor to `max(cursor, input.current)` (monotonic clamp), emits `tick`.
- `status` emits a `status` event without touching cursor and **without** rate limiting.
- `complete` / `fail` emit terminal events carrying whatever `cursor` is at — no synthetic "force past total" math.
- After a terminal event, all further calls are no-ops (`done` flag).

#### `ProgressEvent` (discriminated union)

```ts
type ProgressEvent =
  | { kind: 'tick'; current: number; total?: number; message: string }
  | { kind: 'status'; message: string }
  | { kind: 'complete'; current: number; total?: number; message: string }
  | {
      kind: 'fail';
      current: number;
      total?: number;
      message: string;
      error: unknown;
    };
```

(No `start` event kind — folded into a synthetic first `tick` to match today's wire behavior.)

#### `ProgressSink`

```ts
interface ProgressSink {
  readonly name: string; // for diagnostic logs
  emit(event: ProgressEvent): Promise<void> | void;
}
```

Session calls `emit` after rate-limit / monotonic checks. Each sink is dispatched via an internal `emitGuarded` wrapper that catches sync/async errors and logs them at `Logger.warn` with `{ sink: sink.name, eventKind: event.kind }`. Errors never propagate to the tool handler.

#### `McpProgressSink` (in `tools/progress-sinks.ts`)

- Constructed from `{ progressToken, sendNotification }`.
- Reacts to `tick`, `complete`, `fail`. Ignores `status`.
- Owns the **100%-normalization quirk**: on `complete` / `fail`, computes `displayCurrent = max(event.current, event.total ?? event.current, 1)` and sends `{ progress: displayCurrent, total: displayCurrent, message }`.
- On `tick`, forwards `{ progress: current, total?, message }` directly.

#### `TaskStoreSink` (in `tools/progress-sinks.ts`)

- Constructed from `{ taskStore, taskId }`.
- Reacts to `tick`, `status`, `complete`, `fail`. Calls `taskStore.updateTaskStatus(taskId, 'working', formatMessage(event))`.
- `formatMessage` mirrors today's `formatTaskStatusMessage` for tick/complete/fail; for `status` it uses `event.message` directly.
- Catches the existing benign-error pattern (`/Task .*not found|terminal status/`) inline; other errors propagate to `emitGuarded` and get logged.

#### `progressSessionFromContext(ctx, { label, total? })`

The bridge. Replaces today's `buildProgressSessionFromOnProgress` + `createProgressReporter` + `toolContextToOnProgress` triplet.

1. Inspects `ctx`:
   - If `_meta.progressToken` and `sendNotification` are both present → push `McpProgressSink`.
   - If `task.id` and `task.store` are both present (`isTaskToolContext`) → push `TaskStoreSink`.
2. Returns `new ProgressSession({ label, total, sinks })`. If both checks fail, `sinks` is `[]` and the session no-ops on every emit (same shape, zero overhead).
3. Sink **construction** errors are caught here, logged, and treated as "skip this sink" — the tool runs without that channel rather than failing.

Public helpers `runWithProgressSession`, `createBatchProgressCallbacks`, `completeProgressSession`, `resolveFinalProgressCurrent` keep their existing exported signatures; their bodies become trivial wrappers over `progressSessionFromContext` + the session API.

## Data flow

### Tool with progress

1. `wrapToolHandler` (or a tool calling `runWithProgressSession`) calls `progressSessionFromContext(ctx, { label, total })`.
2. Bridge builds sinks and `new ProgressSession(...)`. Constructor synchronously emits the start `tick`.
3. Handler calls `progress.step(msg)` / `progress.set({...})` / `progress.status(msg)` as work proceeds.
4. Each session method:
   - Mutates cursor (or not, for `status`).
   - Builds the appropriate event.
   - For non-terminal, non-status events: applies 50ms rate limit. If suppressed, returns.
   - Calls `emitGuarded(sink, event)` for each sink (sequentially via `await Promise.all`).
5. Handler returns or throws. The orchestration layer calls `progress.complete(suffix)` or `progress.fail(error, suffix?)`. Terminal events bypass rate limit.

### Tool without progress

`progressSessionFromContext` returns a session whose `sinks` is `[]`. Every method becomes effectively a cursor mutation with no I/O. The tool's progress calls are silent no-ops.

### Status updates from deep call sites

Today: `void reportTaskStatus(msg)` — finds session via ALS.
Tomorrow: callers thread the `progress` they already have, calling `progress.status(msg)`. The two existing call sites ([src/tools/read-multiple.ts:857](../../../src/tools/read-multiple.ts), [src/tools/search-content.ts:1900](../../../src/tools/search-content.ts)) already hold the session in scope.

## Error handling

| Failure mode                                                | Behavior                                                                                                                                               |
| :---------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sink `emit` throws synchronously                            | `emitGuarded` catches; `Logger.warn({ sink, eventKind, err })`; never propagates.                                                                      |
| Sink `emit` returns rejected promise                        | Same as above.                                                                                                                                         |
| Sink constructor throws inside `progressSessionFromContext` | Logged; sink omitted from session; tool continues.                                                                                                     |
| Tool handler throws                                         | Caught by orchestration layer (`completeProgressSession` / `wrapToolHandler`); calls `progress.fail(error)`; rethrows after terminal event dispatches. |
| Out-of-order `set({ current })` (cursor regress)            | Silently clamped via `max(cursor, input.current)`; event still emits with the clamped value.                                                           |
| `complete` after `complete` / `fail` after terminal         | No-op. `done` flag set on first terminal event.                                                                                                        |
| `step` / `set` / `status` after terminal                    | No-op.                                                                                                                                                 |

## Testing strategy

### New tests

- **[\_\_tests\_\_/unit/progress-session.test.ts](../../../__tests__/unit/progress-session.test.ts)** — pure unit tests, no MCP, no `createTestEnv`. Helper `MemorySink` collects events into an array. Coverage:
  - Constructor emits initial `tick` with `current: 0`.
  - `step` increments cursor and emits `tick`.
  - `set` clamps monotonically (regress is silently clamped).
  - `status` emits `status` event, does not advance cursor, is not rate-limited.
  - Rate limit: rapid `step` calls within 50ms drop intermediate ticks; `step` after the window emits.
  - Terminal events bypass rate limit even if fired immediately after a tick.
  - `complete` then `step` → `step` is no-op.
  - `complete` then `complete` → second is no-op.
  - Sink throwing sync error → other sinks still receive the event; tool sees nothing.
  - Sink throwing async error → same.
  - Empty sink array → no errors, no calls.

- **[\_\_tests\_\_/tools/progress-sinks.test.ts](../../../__tests__/tools/progress-sinks.test.ts)** — sinks against fakes:
  - `McpProgressSink`: tick forwards `{ progress, total, message }`. Complete/fail apply 100% normalization (`displayCurrent = max(...)`). Status events are ignored (no notification sent).
  - `TaskStoreSink`: tick/status/complete/fail all call `updateTaskStatus(taskId, 'working', ...)` with the right formatted message. Benign errors (`Task not found`, `terminal status`) are swallowed. Other errors propagate (and get caught upstream by `emitGuarded`).
  - `progressSessionFromContext`: returns a session with `McpProgressSink` only when `_meta.progressToken` + `sendNotification` are present; with `TaskStoreSink` only when task fields are present; with both when both are; with neither (no-op session) otherwise.

### Preserved tests

- `__tests__/tools/task-mode.test.ts`, `__tests__/tools/worker-offload.test.ts`, batch-progress paths — assert observable end-to-end MCP behavior. Unchanged, must pass.
- `__tests__/contract.test.ts` — tool annotations / count. Unchanged.

### Removed / migrated tests

- Any unit test that today exercises `buildProgressSessionFromOnProgress` / `createProgressReporter` / `toolContextToOnProgress` via `createTestEnv` is redundant after the migration; its assertions migrate to the new pure unit tests.

## Migration & breaking changes

The user has approved breaking changes. All breakage is internal to this repo.

### Deleted symbols

- `taskContext: AsyncLocalStorage<TaskContext>` (in `tool-execution.ts`).
- `reportTaskStatus(msg)` free function.
- `withProgress(message, ctx, run, getCompletionMessage?)` private helper.
- `buildProgressSessionFromOnProgress`, `createProgressReporter`, `toolContextToOnProgress` (folded into bridge).
- The free helpers `updateTaskStoreProgress` / `sendMcpProgressNotification` / `reportProgress` / `formatTaskStatusMessage` / `isBenignTaskStatusUpdateError` (absorbed into the sinks).

### Changed shapes

- `ToolProgressSession` interface → `ProgressSession` class with new method names:
  - `update({ current, total?, message })` → `set({ current, total?, message? })`
  - `increment(messageForCurrent)` → `step(message)` — note: callers that built the message from `current` re-derive the count by reading `progress.current` after the call, or precompute. Most call sites already pass a literal string.
  - `complete(message, minimumCurrent?)` → `complete(message)` — the `minimumCurrent` param goes away; MCP 100% normalization is now in the MCP sink.
  - `fail(message, minimumCurrent?)` → `fail(error, message?)` — accepts the underlying error so the session can publish it on the `fail` event for sinks to use; orchestration layer passes it through.
- `getCurrent()` method → `current` getter.

### Affected call sites (~7 tools)

| File                                                                | Changes                                                                                                                                          |
| :------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/tools/read-multiple.ts](../../../src/tools/read-multiple.ts)   | `reportTaskStatus(...)` → `progress.status(...)`. `update({...})` / `increment(...)` calls renamed.                                              |
| [src/tools/search-content.ts](../../../src/tools/search-content.ts) | Same.                                                                                                                                            |
| [src/tools/tree.ts](../../../src/tools/tree.ts)                     | `runWithProgressSession` callers — body callbacks rename `update`/`increment` to `set`/`step`.                                                   |
| [src/tools/search-files.ts](../../../src/tools/search-files.ts)     | Same.                                                                                                                                            |
| [src/tools/calculate-hash.ts](../../../src/tools/calculate-hash.ts) | Same.                                                                                                                                            |
| [src/tools/tool-execution.ts](../../../src/tools/tool-execution.ts) | `wrapToolHandler` rewires to use `progressSessionFromContext` instead of `withProgress`. Re-exports the public helpers from `progress-sinks.ts`. |

### Preserved (no breakage)

- Public tool import paths: `runWithProgressSession`, `createBatchProgressCallbacks`, `completeProgressSession`, `resolveFinalProgressCurrent` continue to be importable from `'./tool-execution.js'` (re-exported from `progress-sinks.ts`).
- `registerStandardTool({ progressMessage, completionMessage })` API unchanged.
- Observable MCP `notifications/progress` payloads unchanged (verified by preserved `task-mode.test.ts`).
- Task-store `'working'` status message strings unchanged.

## Risks

| Risk                                                                                                                                          | Mitigation                                                                                                                                                                   |
| :-------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtle off-by-one in synthetic-first-`tick` vs. today's "fire 0/total at session creation".                                                   | Pure unit test asserts `MemorySink` receives exactly `{ kind: 'tick', current: 0, total, message: label }` first. End-to-end `task-mode.test.ts` catches wire regressions.   |
| Rate-limit window applied differently to `status` (now: not at all; before: didn't apply because reportTaskStatus bypassed reportProgress).   | Behavior is preserved: today's `reportTaskStatus` already bypasses `createProgressReporter`'s rate limit by going through a separate code path.                              |
| 100%-normalization moved into MCP sink might change wire output for the task-store sink's "completed" message format.                         | Task-store sink formats from raw event `current`, not normalized; today it gets the raw cursor value too. Verified by reading `formatTaskStatusMessage` on `complete` paths. |
| `step` no longer accepts a `current => string` callback, breaking any caller that depends on knowing the count _before_ the message is built. | Callers read `progress.current` after the call, or precompute. Audit will confirm — most call sites pass static or pre-built strings.                                        |
