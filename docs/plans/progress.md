# Plan - Make progress metrics honest and align progress/status with MCP v2 built-ins

## Findings from exploration

- Current wrapper emits manual `notifications/tasks/status` payloads from `define.ts` for start/tick/done/fail, but those payloads are not SDK task-status shape and are custom to this repo.
- `TaskOrchestrator` currently intercepts those custom notifications and translates them to `ctx.task.store.updateTaskStatus(...)` for task tools.
- SDK v2 already provides built-in paths for both concerns:
  - task status via `ctx.task.store.updateTaskStatus(...)` and `storeTaskResult(...)`
  - request progress via `notifications/progress` gated by `ctx.mcpReq._meta?.progressToken`
- `list.ts` has a natural insertion point (`collect()` loop) to produce per-entry ticks through the existing `onProgress` channel.

## Design decisions

### Issue 1 - replace custom status/progress wiring with SDK-native behavior

Use SDK-native mechanisms, not custom `notifications/tasks/status` messages from tools:

1. Task-aware calls:
   - update status using `ctx.task.store.updateTaskStatus(ctx.task.id, status, message)`
   - store terminal result with `storeTaskResult(...)`
   - do not manually craft task-status notifications

2. Non-task calls:
   - emit `notifications/progress` only when `ctx.mcpReq._meta?.progressToken` exists
   - do not emit progress/status notifications when no token was requested

3. Keep stderr progress UI (`ProgressSession`) as local operator signal, independent from wire protocol.

### Issue 2 - honest observability counters

Counters should track what actually happened on wire/store boundaries, not internal helper calls:

- `tool_progress_ticks`: count `toolCtx.onProgress` invocations
- `progress_notifications_emitted`: count outbound `notifications/progress` sends
- `task_status_updates_requested`: count calls to `ctx.task.store.updateTaskStatus`

Do not add a counter tied to custom status notifications, because that path is being removed.

### Issue 3 - list per-step progress

- Add `onProgress?: (progress: { current: number; total?: number }) => void` to `CollectOptions`.
- Tick once per visited entry in `collect()` after abort check and before filters.
- Use a pre-filter `scanned` counter and report `{ current: scanned }` (`total` unknown for walk).
- Plumb through both collect passes in truncation flow:
  - `LIST.run` -> `handleList(...)` -> `collect(..., mode: 'inline')`
  - `handleList(...)` -> `collect(..., mode: 'full')` when truncated

## Test plan

1. Define wrapper tests (`__tests__/unit/define-tool.test.ts`):
   - No progress token: no `notifications/progress` emitted.
   - With progress token and one tick: one `notifications/progress` emitted.
   - Task context present and one tick/start/done path: `updateTaskStatus` called expected number of times.

2. List progress tests (`__tests__/tools/directory.test.ts` or dedicated file):
   - Temp tree with nested files.
   - Invoke `list` with captured `onProgress`.
   - Assert at least one callback with `current >= 1`.

3. Observability payload tests:
   - Validate wide event includes renamed counters and no legacy field usage.

## Files to change

| File                               | Change                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| src/tools/define.ts                | Replace manual `notifications/tasks/status` calls with built-in task-store updates and standards-based `notifications/progress` emission (token-gated) |
| src/tools/\_helpers.ts             | Preserve/forward task context into tool-facing context as needed for SDK-native updates                                                                |
| src/tasks.ts                       | Remove custom notification interception that only exists to translate manual status notifications                                                      |
| src/core/observability.ts          | Replace `progress_steps_emitted` with SDK-aligned counters                                                                                             |
| src/tools/list.ts                  | Add and plumb per-entry `onProgress` ticks                                                                                                             |
| **tests**/unit/define-tool.test.ts | Add tests for progress token gating and task-status update calls                                                                                       |
| **tests**/tools/directory.test.ts  | Add list progress callback assertion                                                                                                                   |

## Order of work (TDD)

1. RED: add define-tool tests for progress-token gating and task-status update counting.
2. GREEN: refactor `define.ts` to SDK-native progress/status behavior.
3. REFACTOR: simplify `tasks.ts` interception path that becomes unnecessary.
4. RED: add list progress test.
5. GREEN: plumb list `onProgress` through collect path.
6. RED/GREEN: update observability field names and assertions.
7. Full verification: `node scripts/tasks.mjs check`.

## Scope notes

- This plan intentionally does not implement wire-level rate limiting for progress notifications.
- This plan intentionally does not change tool business logic.
- This plan replaces protocol-shape custom notifications with SDK-defined task/progress surfaces only.
